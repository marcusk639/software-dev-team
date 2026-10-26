import type {
  CanUseTool,
  HookCallbackMatcher,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";

/** What the safety policy needs to know about a run. Built once, before query(). */
export interface Policy {
  /** Real path of --cwd. Writes must resolve inside it. */
  cwd: string;
  /** subagent_type values the manager may delegate to. */
  agents: ReadonlySet<string>;
  /** Roles whose model tier is deliberate, so the manager may not override it. */
  pinnedModels: ReadonlySet<string>;
  /** Values of credential-like environment variables. No tool input may carry one. */
  secretValues: readonly string[];
}

const CREDENTIAL_NAME =
  /(API_?KEY|TOKEN|SECRET|PASSW(OR)?D|PRIVATE_KEY|CREDENTIALS?)/i;
// Short values (feature flags, "true") would match ordinary text.
const MIN_SECRET_LENGTH = 12;

export function createPolicy(options: {
  cwd: string;
  agents: Iterable<string>;
  pinnedModels: Iterable<string>;
  env?: NodeJS.ProcessEnv;
}): Policy {
  const env = options.env ?? process.env;
  return {
    cwd: realpathSync(options.cwd),
    agents: new Set(options.agents),
    pinnedModels: new Set(options.pinnedModels),
    secretValues: Object.entries(env).flatMap(([name, value]) =>
      CREDENTIAL_NAME.test(name) &&
      value !== undefined &&
      value.length >= MIN_SECRET_LENGTH
        ? [value]
        : [],
    ),
  };
}

/**
 * Commands that are never allowed, in any permission mode. Matched against the
 * Bash string (with git's global options stripped) so a compound command
 * cannot smuggle one past the check. `[^|;&\n]*` keeps a match inside one
 * command of a pipeline or list.
 *
 * This is a second layer, not a sandbox: interpreter one-liners and scripts can
 * do anything these patterns name. Under --yes, the CLI itself refuses most
 * Bash that the run has not allow-listed (see allowlist.ts).
 */
const HARD_DENY: Array<{ pattern: RegExp; why: string }> = [
  {
    // rm as its own word, however it is reached (after a wrapper, inside
    // bash -c, path-qualified). A subcommand of git, docker and the like is
    // a different tool: `git rm -r --cached` only untracks files.
    pattern:
      /(?<!\b(?:git|docker|podman|kubectl|helm|npm|pnpm|yarn)\s+)(?:^|(?<=[\s;&|({'"`]))(?:\S*\/)?\\?rm\b[^|;&\n]*\s(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?=\s|$|['"])/,
    why: "recursive delete",
  },
  {
    pattern: /\bfind\b[^|;&\n]*\s-(delete|exec(dir)?\s+rm)\b/,
    why: "bulk delete through find",
  },
  {
    pattern:
      /\bgit\s+push\b[^|;&\n]*\s(--force(-with-lease|-if-includes)?|--mirror|--delete|--prune|-[a-zA-Z]*[fd][a-zA-Z]*)(?=\s|=|$)/,
    why: "force push or remote branch deletion",
  },
  {
    pattern: /\bgit\s+push\b[^|;&\n]*\s[+:]\S/,
    why: "force push or remote branch deletion",
  },
  { pattern: /\bgit\s+reset\s+--hard\b/, why: "discards uncommitted work" },
  {
    pattern:
      /\bgit\s+checkout\b[^|;&\n]*\s(--|\.|--force|-[a-zA-Z]*[fB][a-zA-Z]*)(?=\s|$)/,
    why: "discards uncommitted work",
  },
  {
    pattern:
      /\bgit\s+switch\b[^|;&\n]*\s(--force|--discard-changes|-[a-zA-Z]*[fC][a-zA-Z]*)(?=\s|$)/,
    why: "discards uncommitted work",
  },
  {
    pattern: /\bgit\s+restore\b(?![^|;&\n]*--staged)/,
    why: "discards uncommitted work",
  },
  {
    pattern: /\bgit\s+restore\b[^|;&\n]*(--worktree|\s-W\b)/,
    why: "discards uncommitted work",
  },
  {
    pattern: /\bgit\s+clean\b[^|;&\n]*\s(-[a-zA-Z]*f[a-zA-Z]*|--force)(?=\s|$)/,
    why: "deletes untracked files",
  },
  {
    pattern: /\bgit\s+branch\b[^|;&\n]*\s-[a-zA-Z]*D[a-zA-Z]*(?=\s|$)/,
    why: "force-deletes a branch",
  },
  { pattern: /\bgit\s+stash\s+(drop|clear)\b/, why: "deletes stashed work" },
  {
    // Aliases and these settings make later git commands run something else,
    // so they would slip past every git rule above. Checked on the raw
    // command too, since normalizeGit drops `-c key=value`.
    pattern:
      /\bgit\b[^|;&\n]*(\sconfig\b[^|;&\n]*\s|\s-c\s*)(alias\.|core\.(hooksPath|fsmonitor|sshCommand|pager|editor|askPass)\b|credential\.helper\b)/i,
    why: "changes what git runs",
  },
  {
    // Only when sent to a database client: writing a migration file that
    // contains DROP TABLE, or grepping for it, is ordinary work.
    pattern:
      /\b(psql|mysql|mariadb|sqlite3|pgcli|duckdb)\b[^|;&]*\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i,
    why: "destructive schema change",
  },
  {
    pattern:
      /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b[^;&]*\|\s*(psql|mysql|mariadb|sqlite3|pgcli|duckdb)\b/i,
    why: "destructive schema change",
  },
  { pattern: /\bprisma\s+migrate\s+reset\b/, why: "resets the database" },
  {
    pattern: /\bprisma\s+db\s+push\b[^|;&\n]*--accept-data-loss/,
    why: "accepts data loss",
  },
  { pattern: /\bdropdb\b/, why: "drops a database" },
  {
    pattern: /\b(curl|wget)\b[^|;&\n]*\|\s*(sudo\s+)?(\S*\/)?(ba|z|da|k)?sh\b/,
    why: "pipes a remote script to a shell",
  },
  {
    pattern: /[$<]\(\s*(curl|wget)\b/,
    why: "runs a remote script",
  },
  {
    pattern: /\b(curl|wget)\b.*&&\s*(sudo\s+)?(ba|z)?sh\s+\S/,
    why: "downloads and runs a script",
  },
  {
    pattern: /\b(npm|pnpm|yarn)\b[^|;&\n]*\spublish\b/,
    why: "publishes to a registry",
  },
  { pattern: />\s*\/dev\/[sh]d[a-z]/, why: "writes to a raw device" },
];

/** `git -C dir push` and `git -c k=v push` must match the same rules as `git push`. */
function normalizeGit(command: string): string {
  return command.replace(
    /\bgit(?:\s+(?:(?:-C|-c|--git-dir|--work-tree|--namespace)(?:\s+|=)\S+|--no-pager|--paginate|-p|--bare|--no-replace-objects))+(?=\s)/g,
    "git",
  );
}

/**
 * Files that hold credentials, matched against a whole path. Case-insensitive
 * because the default macOS filesystem is: `.ENV` opens `.env`.
 */
const SECRET_PATH = [
  /(^|\/)\.env(\.(?!(example|sample|template|dist)~?$)[\w.-]+)?~?$/i,
  /(^|\/)\.envrc$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)$/i,
  /(^|\/)\.(ssh|aws|kube)(\/|$)/i,
  /(^|\/)\.docker\/config\.json$/i,
  /\.(pem|key|p12|pfx|tfvars)$/i,
  /(^|\/)credentials(\.json)?$/i,
  /(^|\/)\.(netrc|pgpass|git-credentials|npmrc)$/i,
  /(^|\/)\.credentials\.json$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)\.gnupg(\/|$)/i,
  /(^|\/)\.config\/(gh|gcloud)(\/|$)/i,
  /\.tfstate(\.backup)?$/i,
  /^\/proc\/[^/]+\/environ$/,
];

/**
 * The same material as SECRET_PATH, found as tokens inside a shell command or a
 * glob. Any mention is refused, not only writes: reading a secret into the
 * transcript is the leak.
 */
const SECRET_IN_TEXT = [
  /(^|[\s"'=|;&(<>/*:\\])\.env(?!\.(example|sample|template|dist)\b)(?=$|[\s"'|;&)<>.*/~])/i,
  /(^|[\s"'=|;&(<>/:\\])\.envrc\b/i,
  /\bid_(rsa|ed25519|ecdsa|dsa)\b(?!\.pub)/i,
  /\.(ssh|aws|kube)\//i,
  /\.docker\/config\.json\b/i,
  /\.(pem|p12|pfx|tfvars)\b/i,
  /\bcredentials\.json\b/i,
  /\.(netrc|pgpass|git-credentials|npmrc)\b/i,
  /\.credentials\.json\b/i,
  /\.pypirc\b/i,
  /\.gnupg\//i,
  /\.config\/(gh|gcloud)\//i,
  /\.tfstate\b/i,
];

/**
 * Commit messages, PR titles and bodies often name protected files ("add .env
 * to .gitignore"). Their quoted text is dropped before the mention checks.
 * Double-quoted text that could run a substitution is kept, so
 * `-m "$(cat .env)"` is still seen.
 */
function withoutMessages(command: string): string {
  return command.replace(
    /(\s(?:-m|--message|--title|--body)(?:=|\s+))('[^']*'|"(?:[^"\\$\x60]|\\.)*")/g,
    "$1''",
  );
}

/** `echo .env >> .gitignore` names a secret file without reading it. */
const IGNORE_FILE_APPEND =
  /^\s*(echo|printf)\s[^|;&<>`$]*>>?\s*(\S*\/)?\.(git|docker)ignore\s*$/i;

/**
 * A command position: the start, after a shell separator or keyword, or after
 * a wrapper. `cd env` and `docker ps` are arguments, not commands.
 */
const AT = String.raw`(^|[;&|(){\x60\n]\s*|\b(?:sudo|time|command|exec|nohup|then|do|else)\s+)`;
const ENDS = String.raw`\s*($|[|;&>)}\x60])`;

/**
 * Ways to print the process environment, which holds the API key. Scripts and
 * test suites can still read it; masking it needs the SDK sandbox's credential
 * settings.
 */
const ENV_DUMP = [
  new RegExp(String.raw`${AT}env(\s+-\S*)*${ENDS}`),
  new RegExp(String.raw`${AT}export(\s+-p)?${ENDS}`),
  new RegExp(
    String.raw`${AT}(declare|typeset)\s+-[a-zA-Z]*[px][a-zA-Z]*${ENDS}`,
  ),
  new RegExp(String.raw`${AT}set${ENDS}`),
  /\bcompgen\s+-\w*[ev]/,
  new RegExp(String.raw`${AT}ps\s+-?[a-zA-Z]*[eE][a-zA-Z]*(?=\s|$)`),
  /\bprintenv\b/,
  /\$\{?[A-Za-z_]*(API_?KEY|TOKEN|SECRET|PASSW(OR)?D|PRIVATE_KEY|CREDENTIAL)/i,
  /\/proc\/[^\s/]+\/environ\b/,
  // Only inside an interpreter one-liner: code that mentions process.env is
  // ordinary, and grepping or editing it must keep working.
  /\b(node|nodejs|python3?|ruby|perl|deno|bun|php)\b[^|&\n]*\s(-e|-c|-p|-E|-r|--eval|--print)\b[^\n]*(process\.env|os\.environ|getenv|\bENV\b|%ENV|\$_ENV|Deno\.env)/,
  /\bsecurity\s+(find|dump)-\w+/,
];

/**
 * Paths agents must not write, even inside the project. `.claude/` and
 * `.mcp.json` load as hooks, agents and MCP servers on the next run
 * (settingSources: ["project"]), so a write there persists past this one.
 */
const PROTECTED_WRITE = [
  ...SECRET_PATH,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)\.pub$/i,
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)\.claude(\/|$)/i,
  /(^|\/)\.mcp\.json$/i,
];

/** Mentions of git internals or agent configuration inside a shell command. */
const CONFIG_MENTION = [
  /(^|[^\w.-])\.(claude|git)(?=$|[/\s"'|;&)<>])/i,
  /\.mcp\.json\b/i,
];

const READ_ONLY_COMMANDS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "wc",
  "stat",
  "file",
  "du",
  "tree",
  "pwd",
  "cd",
  "echo",
  "test",
  "[",
]);
const READ_ONLY_GIT = new Set([
  "status",
  "log",
  "diff",
  "show",
  "ls-files",
  "rev-parse",
  "blame",
  "check-ignore",
  "grep",
]);

/**
 * True when every command in the pipeline only reads. Writes can come from
 * dozens of verbs (touch, mkdir, tar, curl -o, perl -i…), so commands that
 * mention protected paths are judged by what they are allowed to be, not by
 * a list of what they must not be.
 */
function isReadOnly(command: string): boolean {
  // Nested commands run whatever they contain, whatever the outer verb is.
  if (/\$\(|`|[<>]\(/.test(command)) return false;
  // Any redirect writes, except the forms that only discard or merge output.
  const withoutBenign = command.replace(/\d?>&\d|&?\d?>\s*\/dev\/null/g, "");
  if (/>/.test(withoutBenign)) return false;
  return withoutBenign
    .split(/&&|\|\||[|;&\n]/)
    .map((segment) => segment.trim().replace(/^(\w+=\S*\s+)+/, ""))
    .filter(Boolean)
    .every((segment) => {
      // Flags that make a reading command write a file or run a program.
      if (
        /(^|\s)(--output\b|--pre\b|--ext-diff\b|-fls\b|-fprint)/.test(
          segment,
        ) ||
        /^tree\b.*\s-o\b/.test(segment)
      ) {
        return false;
      }
      // `git -C dir` and `--no-pager` only change where and how git reads.
      const [head = "", sub = ""] = segment
        .replace(/^\\/, "")
        .replace(/^git\s+((-C\s+\S+|--no-pager)\s+)+/, "git ")
        .split(/\s+/);
      // Judged before git's global options are stripped, so `git -c ...` never counts as read-only.
      if (head === "git") return READ_ONLY_GIT.has(sub);
      if (head === "find")
        return !/\s-(delete|exec|execdir|ok|fprint)/.test(segment);
      return READ_ONLY_COMMANDS.has(head);
    });
}

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const DELEGATION_TOOLS = new Set(["Agent", "Task"]);

/**
 * The only tools the manager may use itself: reading, planning and
 * delegating. Its prompt already says so, but a haiku manager ran a refused
 * command itself in a live run; this makes the role boundary hold regardless
 * of the model. It is an allowlist because the preset also carries Skill,
 * shell helpers and any MCP tool the target repo's .mcp.json adds, any of
 * which could write or reach the network. The manager reads every
 * specialist's report, which carries content from the target repo, so
 * untrusted input plus outbound requests is the combination to avoid.
 */
const MANAGER_ALLOWED = new Set([
  "Read",
  "Grep",
  "Glob",
  "Agent",
  "Task",
  "TodoWrite",
  "ToolSearch",
]);
const MAX_SYMLINK_HOPS = 40;

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function targetPath(input: Record<string, unknown>): string {
  return asString(input.file_path) || asString(input.notebook_path);
}

/** Every path a write tool could act on; a second field must not smuggle one past the check. */
function targetPaths(input: Record<string, unknown>): string[] {
  return [asString(input.file_path), asString(input.notebook_path)].filter(
    Boolean,
  );
}

/**
 * Where a write would really land. Symlinks are followed through the nearest
 * existing ancestor, and a dangling link is followed to its target, since a
 * write through it creates the target.
 */
function realTarget(cwd: string, path: string): string {
  let current = resolve(cwd, path);
  const tail: string[] = [];
  for (let hops = 0; hops < MAX_SYMLINK_HOPS; hops += 1) {
    let isLink: boolean;
    try {
      isLink = lstatSync(current).isSymbolicLink();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(current);
      if (parent === current) return join(current, ...tail);
      tail.unshift(basename(current));
      current = parent;
      continue;
    }
    if (isLink && !existsSync(current)) {
      current = resolve(dirname(current), readlinkSync(current));
      continue;
    }
    return join(realpathSync(current), ...tail);
  }
  throw new Error(`Too many symbolic links resolving ${path}`);
}

function containsSecret(
  policy: Policy,
  input: Record<string, unknown>,
): boolean {
  const serialized = JSON.stringify(input) ?? "";
  return policy.secretValues.some(
    (secret) =>
      serialized.includes(secret) ||
      serialized.includes(JSON.stringify(secret).slice(1, -1)),
  );
}

/**
 * The single source of truth for what is forbidden. Returns a reason when the
 * call must be blocked, or null when it is acceptable.
 */
export function denyReason(
  policy: Policy,
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  if (containsSecret(policy, input)) {
    return "That call contains the value of a credential from the environment. Ask the human operator to do it directly.";
  }

  if (DELEGATION_TOOLS.has(toolName)) {
    const type = asString(input.subagent_type);
    if (!policy.agents.has(type)) {
      return `${type ? `"${type}" is not on this team` : "A delegation must name a subagent_type"}. Delegate to one of: ${[...policy.agents].join(", ")}.`;
    }
    if (input.model !== undefined && policy.pinnedModels.has(type)) {
      return `${type} runs on the model its definition sets. Delegate again without a model override.`;
    }
    if (input.isolation === "remote") {
      return "Remote agents run outside this run's safety hooks. Delegate without isolation: remote.";
    }
    return null;
  }

  if (toolName === "Bash") {
    // A backslash-newline continues the line; join it so per-line rules see the whole command.
    const raw = asString(input.command).replace(/\\\r?\n/g, " ");
    const command = normalizeGit(raw);
    const hit = HARD_DENY.find(
      (rule) => rule.pattern.test(command) || rule.pattern.test(raw),
    );
    if (hit) {
      return `Blocked by the team's safety policy (${hit.why}). If this is genuinely required, ask the human operator to run it directly.`;
    }
    const mentions = withoutMessages(raw);
    if (
      (!IGNORE_FILE_APPEND.test(mentions) &&
        SECRET_IN_TEXT.some((p) => p.test(mentions))) ||
      ENV_DUMP.some((p) => p.test(command))
    ) {
      return "That command reads secrets or the process environment. Ask the human operator for what you need instead.";
    }
    // A protected path can also be written from the shell, which never reaches
    // the Write tool, so any command touching one must be read-only.
    if (CONFIG_MENTION.some((p) => p.test(mentions)) && !isReadOnly(mentions)) {
      return "That command may write to git internals or agent configuration. Only read-only commands may touch those paths; ask the human operator to do it directly.";
    }
    return null;
  }

  if (
    toolName === "Read" &&
    SECRET_PATH.some((p) => p.test(targetPath(input)))
  ) {
    return "That file holds secrets. Ask the human operator for what you need instead.";
  }

  if (toolName === "Grep" || toolName === "Glob") {
    const path = asString(input.path);
    const globs = [
      asString(input.glob),
      toolName === "Glob" ? asString(input.pattern) : "",
    ];
    if (
      SECRET_PATH.some((p) => p.test(path)) ||
      globs.some((g) => g && SECRET_IN_TEXT.some((p) => p.test(g)))
    ) {
      return "That search targets files that hold secrets.";
    }
  }

  if (WRITE_TOOLS.has(toolName)) {
    for (const path of targetPaths(input)) {
      const real = realTarget(policy.cwd, path);
      const inside = real === policy.cwd || real.startsWith(policy.cwd + sep);
      if (!inside) {
        return `Writing to ${path} is not permitted: it resolves outside the project directory.`;
      }
      const projectPath = relative(policy.cwd, real);
      if (PROTECTED_WRITE.some((p) => p.test(path) || p.test(projectPath))) {
        return `Writing to ${path} is not permitted (secrets, git internals or agent configuration).`;
      }
    }
  }

  return null;
}

/** A policy that cannot be evaluated denies: failing open would skip the check. */
function safeDenyReason(
  policy: Policy,
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  try {
    return denyReason(policy, toolName, input);
  } catch (error) {
    return `The safety check could not evaluate this call (${(error as Error).message}), so it is blocked.`;
  }
}

/**
 * The hard-deny list lives in a PreToolUse hook rather than in `canUseTool`
 * because `canUseTool` is skipped whenever the permission mode already
 * auto-approves a call — under `acceptEdits` or `bypassPermissions` it would
 * never see an Edit at all. The hook runs for every tool call in every mode,
 * including calls made inside subagents, so "yes to everything" still cannot
 * mean "yes to rm -rf".
 */
export function createSafetyHooks(
  policy: Policy,
  onDeny?: (toolUseId: string, reason: string) => void,
): Record<"PreToolUse", HookCallbackMatcher[]> {
  return {
    PreToolUse: [
      {
        hooks: [
          async (input) => {
            if (input.hook_event_name !== "PreToolUse")
              return { continue: true };
            // agent_id is absent only on the main thread, i.e. the manager.
            const reason =
              input.agent_id === undefined &&
              !MANAGER_ALLOWED.has(input.tool_name)
                ? `The manager reads and delegates; it does not use ${input.tool_name}. Delegate this to the specialist whose role covers it.`
                : safeDenyReason(
                    policy,
                    input.tool_name,
                    (input.tool_input ?? {}) as Record<string, unknown>,
                  );
            if (reason === null) {
              if (!DELEGATION_TOOLS.has(input.tool_name)) {
                return { continue: true };
              }
              // Background delegations proved unreliable live (SDK 0.3.283):
              // after the first refusal, a background agent's later tool
              // calls were rejected before this hook ran. Foreground
              // delegations were screened call by call, so every delegation
              // waits for its result. Parallelism comes from several Agent
              // calls in one message.
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  updatedInput: {
                    ...(input.tool_input as Record<string, unknown>),
                    run_in_background: false,
                  },
                },
              };
            }
            onDeny?.(input.tool_use_id, reason);
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: reason,
              },
            };
          },
        ],
      },
    ],
  };
}

/**
 * Interactive approval for everything the hook did not already reject. Only
 * reached in `default` mode; `--yes` relies on the hook alone.
 */
export function createPermissionGate(policy: Policy): CanUseTool {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  return async (toolName, input): Promise<PermissionResult> => {
    const reason = safeDenyReason(policy, toolName, input);
    if (reason !== null) return { behavior: "deny", message: reason };

    // Control characters could rewrite the prompt line the human is approving.
    const detail = (
      toolName === "Bash"
        ? asString(input.command)
        : targetPath(input) || asString(input.pattern)
    ).replace(/[\x00-\x1f\x7f]+/g, " ");

    const answer = await rl.question(
      `\n  ⚠  ${toolName}${detail ? `  ${detail}` : ""}\n     allow? [y/N] `,
    );

    return answer.trim().toLowerCase() === "y"
      ? { behavior: "allow" }
      : {
          behavior: "deny",
          message: "The human operator declined this action.",
        };
  };
}
