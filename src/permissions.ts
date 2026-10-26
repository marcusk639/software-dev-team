import type {
  CanUseTool,
  HookCallbackMatcher,
  HookInput,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  isSecretGlob,
  isSecretPath,
  resolvesInside,
  writeDenyReason,
} from "./permissions/paths.js";
import { bashDenyReason } from "./permissions/shell.js";
import {
  DELEGATION_TOOLS,
  isOneOf,
  MANAGER_ALLOWED,
  type ToolName,
  WRITE_TOOLS,
} from "./tools.js";

export { bashDenyReason } from "./permissions/shell.js";
export { WRITE_TOOLS } from "./tools.js";

const BUILT_BY_CREATE_POLICY = Symbol("Policy");

/**
 * What the safety policy needs to know about a run. Built once, before
 * query(), and only by createPolicy: the brand keeps a hand-built literal
 * (with an unresolved cwd, say) from type-checking as a Policy.
 */
export interface Policy {
  /** Real path of --cwd. Writes must resolve inside it. */
  readonly cwd: string;
  /** subagent_type values the manager may delegate to. */
  readonly agents: ReadonlySet<string>;
  /** Roles whose model tier is deliberate, so the manager may not override it. */
  readonly pinnedModels: ReadonlySet<string>;
  /** Values of credential-like environment variables. No tool input may carry one. */
  readonly secretValues: readonly string[];
  /**
   * Real paths Read, Grep and Glob may reach without approval: --cwd, plus
   * the directories of Read/Grep/Glob allow rules.
   */
  readonly readRoots: readonly string[];
  /**
   * Whether a human can approve a call. A read outside readRoots is put to
   * them; unattended (--yes), it is denied.
   */
  readonly interactive: boolean;
  readonly [BUILT_BY_CREATE_POLICY]: true;
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
  /** Directories outside --cwd that reads may reach (from allow rules). */
  readRoots?: Iterable<string>;
  /** True when a human answers approval prompts (no --yes). Default false. */
  interactive?: boolean;
}): Policy {
  const env = options.env ?? process.env;
  const cwd = realpathSync(options.cwd);
  const realOrResolved = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  return Object.freeze({
    cwd,
    readRoots: Object.freeze([
      cwd,
      ...[...(options.readRoots ?? [])].map(realOrResolved),
    ]),
    interactive: options.interactive ?? false,
    agents: new Set(options.agents),
    pinnedModels: new Set(options.pinnedModels),
    secretValues: Object.freeze(
      Object.entries(env).flatMap(([name, value]) =>
        CREDENTIAL_NAME.test(name) &&
        value !== undefined &&
        value.length >= MIN_SECRET_LENGTH
          ? [value]
          : [],
      ),
    ),
    [BUILT_BY_CREATE_POLICY]: true as const,
  });
}

/** Who made a tool call: the manager's own thread, or a specialist. */
export type Actor =
  { kind: "manager" } | { kind: "agent"; type: string; id: string };

/**
 * agent_id is present only inside a subagent. agent_type alone is not enough:
 * the SDK also sets it on the main thread of a session started with --agent.
 */
export function actorOf(
  input: Pick<HookInput, "agent_id" | "agent_type">,
): Actor {
  return input.agent_id === undefined
    ? { kind: "manager" }
    : {
        kind: "agent",
        type: input.agent_type ?? "unknown",
        id: input.agent_id,
      };
}

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
 * call must be blocked, or null when it is acceptable. May throw (a symlink
 * loop, an unreadable directory); callers treat a throw as a deny.
 */
export function denyReason(
  policy: Policy,
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  if (containsSecret(policy, input)) {
    return "That call contains the value of a credential from the environment. Ask the human operator to do it directly.";
  }

  if (isOneOf(DELEGATION_TOOLS, toolName)) {
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
    return bashDenyReason(asString(input.command), policy.cwd);
  }

  if (toolName === "Read" && isSecretPath(policy.cwd, targetPath(input))) {
    return "That file holds secrets. Ask the human operator for what you need instead.";
  }

  if (toolName === "Grep" || toolName === "Glob") {
    // Glob only lists names, so its pattern is not screened; Grep prints
    // contents and always runs ripgrep with --hidden.
    if (
      isSecretPath(policy.cwd, asString(input.path)) ||
      (toolName === "Grep" && isSecretGlob(asString(input.glob)))
    ) {
      return "That search targets files that hold secrets.";
    }
    if (
      toolName === "Grep" &&
      input.output_mode === "content" &&
      !resolvesInside(policy.cwd, policy.readRoots, asString(input.path))
    ) {
      return "Printing search results from outside the project is not permitted: Grep searches hidden files, credentials included. Search inside the project, or ask the human operator.";
    }
  }

  if (isOneOf(WRITE_TOOLS, toolName)) {
    for (const path of targetPaths(input)) {
      const reason = writeDenyReason(policy.cwd, path);
      if (reason) return reason;
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

const READ_TOOLS = ["Read", "Grep", "Glob"] as const satisfies readonly ToolName[];

/**
 * The directory a glob starts from: its segments before the first wildcard,
 * with `~` as the home directory, resolved against `base`. `/etc/*` starts at
 * /etc, `../../**` two levels up, `src/*.ts` at src.
 */
function globBase(glob: string, base: string): string {
  const segments = glob.split("/");
  const wild = segments.findIndex((s) => /[?*[{]/.test(s));
  const fixed = (wild === -1 ? segments : segments.slice(0, wild)).join("/");
  if (fixed === "~" || fixed.startsWith("~/")) {
    return resolve(homedir(), `.${fixed.slice(1)}`);
  }
  return resolve(base, fixed || (glob.startsWith("/") ? "/" : "."));
}

/**
 * Every place a read tool call can reach: Read's file, Grep's and Glob's
 * `path`, the static base of Glob's pattern, and the base of each Grep glob
 * piece that is absolute, starts at `~` or climbs with `..`.
 */
function readTargets(
  policy: Policy,
  toolName: string,
  input: Record<string, unknown>,
): string[] {
  if (toolName === "Read") return [targetPath(input)];
  const path = asString(input.path);
  const searchRoot = resolve(policy.cwd, path || ".");
  if (toolName === "Glob") {
    return [path, globBase(asString(input.pattern), searchRoot)];
  }
  const pieces = asString(input.glob)
    .split(/[\s,]+/)
    .map((piece) => piece.replace(/^!/, ""))
    .filter((piece) => /^(\/|~)|(^|\/)\.\.(\/|$)/.test(piece));
  return [path, ...pieces.map((piece) => globBase(piece, searchRoot))];
}

/**
 * Why a read needs a human's approval: it reaches outside --cwd and the
 * directories allow rules name. Claude Code's own session files (large tool
 * results saved next to the transcript) stay readable. May throw (symlink
 * loop); callers treat a throw as a deny.
 */
export function approvalReason(
  policy: Policy,
  toolName: string,
  input: Record<string, unknown>,
  transcriptPath?: string,
): string | null {
  if (!isOneOf(READ_TOOLS, toolName)) return null;
  // Large tool results are saved under <transcript dir>/<session id>/; only
  // that session directory is exempt, never the transcript's parent.
  // (Assumed from observed runs; unverified against SDK 0.3.283's docs.)
  const roots = transcriptPath
    ? [
        ...policy.readRoots,
        join(dirname(transcriptPath), basename(transcriptPath, ".jsonl")),
      ]
    : policy.readRoots;
  const outside = readTargets(policy, toolName, input).find(
    (path) => !resolvesInside(policy.cwd, roots, path),
  );
  if (outside === undefined) return null;
  return `${outside || "That path"} is outside the project. Reading outside --cwd needs the human operator's approval${policy.interactive ? "" : ', which an unattended (--yes) run cannot give; allow the directory with --allow "Read(//abs/dir/**)" or ask the operator'}.`;
}

/**
 * Tools whose calls must finish before the hook's verdict is final. A
 * background Bash or delegation returns at once, so PostToolUse would record
 * it as done while it is still running, and background delegations proved
 * unreliable live (SDK 0.3.283): after the first refusal, a background
 * agent's later tool calls were rejected before this hook ran. Parallelism
 * comes from several calls in one message.
 */
const FOREGROUND_ONLY = [...DELEGATION_TOOLS, "Bash"];

const deny = (reason: string) => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse" as const,
    permissionDecision: "deny" as const,
    permissionDecisionReason: reason,
  },
});

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
            // Anything that throws in here denies the call: an exception
            // escaping a hook would leave the decision to the SDK.
            try {
              if (input.hook_event_name !== "PreToolUse")
                return { continue: true };
              const toolInput = (input.tool_input ?? {}) as Record<
                string,
                unknown
              >;
              const reason =
                actorOf(input).kind === "manager" &&
                !isOneOf(MANAGER_ALLOWED, input.tool_name)
                  ? `The manager reads and delegates; it does not use ${input.tool_name}. Delegate this to the specialist whose role covers it.`
                  : safeDenyReason(policy, input.tool_name, toolInput);
              if (reason !== null) {
                onDeny?.(input.tool_use_id, reason);
                return deny(reason);
              }
              const approval = approvalReason(
                policy,
                input.tool_name,
                toolInput,
                input.transcript_path,
              );
              if (approval !== null) {
                if (!policy.interactive) {
                  onDeny?.(input.tool_use_id, approval);
                  return deny(approval);
                }
                // Put it to the human even if a bare allow rule (Grep, Glob)
                // or the mode would approve it on its own.
                return {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse" as const,
                    permissionDecision: "ask" as const,
                    permissionDecisionReason: approval,
                  },
                };
              }
              if (!FOREGROUND_ONLY.includes(input.tool_name)) {
                return { continue: true };
              }
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse" as const,
                  updatedInput: { ...toolInput, run_in_background: false },
                },
              };
            } catch (error) {
              return deny(
                `The safety check failed (${(error as Error)?.message ?? String(error)}), so this call is blocked.`,
              );
            }
          },
        ],
      },
    ],
  };
}

/** A search as the approval prompt shows it: the pattern, where it looks, and its glob. */
function searchShown(
  policy: Policy,
  toolName: "Grep" | "Glob",
  input: Record<string, unknown>,
): string {
  const pattern = asString(input.pattern);
  const path = asString(input.path);
  const glob = asString(input.glob);
  const base =
    toolName === "Glob"
      ? globBase(pattern, resolve(policy.cwd, path || "."))
      : undefined;
  return [
    pattern,
    path && `in ${path}`,
    glob && `(glob ${glob})`,
    base !== undefined && base !== policy.cwd && `(from ${base})`,
  ]
    .filter(Boolean)
    .join(" ");
}

/** Asks the human a question and resolves with the answer line. */
export type Ask = (question: string) => Promise<string>;

/**
 * An Ask on stdin that rejects when input closes instead of hanging. The
 * readline interface is opened on the first question, so building a gate
 * (in a test, or a run that never prompts) does not hold stdin open.
 */
function askOnStdin(): Ask {
  let rl: ReturnType<typeof createInterface> | undefined;
  let closed = false;
  const open = () => {
    if (rl) return rl;
    rl = createInterface({ input: process.stdin, output: process.stdout });
    // Ctrl-C at the prompt stops the run instead of leaving it waiting.
    rl.on("SIGINT", () => process.kill(process.pid, "SIGINT"));
    rl.once("close", () => {
      closed = true;
    });
    return rl;
  };
  return (question) =>
    new Promise<string>((resolve, reject) => {
      const rl = open();
      if (closed) return reject(new Error("input is closed"));
      const onClose = () => reject(new Error("input is closed"));
      rl.once("close", onClose);
      rl.question(question).then(
        (answer) => {
          rl.off("close", onClose);
          resolve(answer);
        },
        (error: unknown) => {
          rl.off("close", onClose);
          reject(error);
        },
      );
    });
}

/**
 * Interactive approval for everything the hook did not already reject. Only
 * installed without --yes. Under --yes the CLI runs in acceptEdits mode with
 * no gate: file edits inside --cwd and the filesystem commands acceptEdits
 * covers are auto-approved, allow-listed tools run, other Bash is refused,
 * and the safety hook screens all of it first.
 */
export function createPermissionGate(
  policy: Policy,
  ask: Ask = askOnStdin(),
): CanUseTool {
  return async (toolName, input): Promise<PermissionResult> => {
    const reason = safeDenyReason(policy, toolName, input);
    if (reason !== null) return { behavior: "deny", message: reason };

    // Show what the call will actually do: the command, the path, the URL, or
    // else the arguments, so nothing (an MCP query, a fetch) is approved blind.
    // Control characters are stripped because they could rewrite this line.
    const shown =
      toolName === "Bash"
        ? asString(input.command)
        : toolName === "Grep" || toolName === "Glob"
          ? searchShown(policy, toolName, input)
          : targetPath(input) ||
            asString(input.url) ||
            asString(input.pattern) ||
            JSON.stringify(input);
    const detail = shown.replace(/[\x00-\x1f\x7f]+/g, " ").slice(0, 2000);

    let answer: string;
    try {
      answer = await ask(
        `\n  ⚠  ${toolName}${detail ? `  ${detail}` : ""}\n     allow? [y/N] `,
      );
    } catch {
      return {
        behavior: "deny",
        message:
          "No answer from the human operator (input closed), so this action is denied.",
      };
    }

    return answer.trim().toLowerCase() === "y"
      ? { behavior: "allow" }
      : {
          behavior: "deny",
          message: "The human operator declined this action.",
        };
  };
}
