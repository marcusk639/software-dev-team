/**
 * Tool permission rules granted for the whole run, passed to the SDK as
 * `allowedTools`. They decide what can run without a human: under --yes the
 * CLI auto-approves only file edits inside --cwd and a few filesystem
 * commands, and refuses every other Bash command it is not told to allow.
 * Without a rule here, via --allow, or in the target's own
 * .claude/settings.json, qa-tester cannot run the target's tests unattended.
 *
 * The safety hook still runs first, so an allowed rule can never unlock a
 * command the hook denies. Interactive runs skip the y/N prompt for these too.
 *
 * Rule syntax is Claude Code's permission-rule syntax:
 *   "Bash(pnpm test:*)"   the command and anything after it
 *   "Bash(git status)"    exactly this command
 *   "WebFetch(domain:docs.example.com)"
 *   "Read(//opt/docs/**)" an absolute directory tree (`//` = absolute)
 *   "Read(~/notes/**)"    under the home directory
 *   "Read(/docs/**)"      relative to the project (one leading `/`), as is
 *                         a bare "Read(docs/**)"
 *   "mcp__server__tool"
 * A Read, Grep or Glob rule outside the project opens that directory tree to
 * reads without approval (see prepareAllowRules); one that would open the
 * filesystem root, the home directory or a parent of the project is refused.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { bashDenyReason } from "./permissions/shell.js";
import { WRITE_TOOLS } from "./tools.js";

/**
 * Granted on every run. The native CLI hides Grep and Glob unless they are
 * allow-listed, which left the read-only roles with no way to search.
 */
export const BASE_ALLOWED_TOOLS = ["Grep", "Glob"] as const;

/**
 * Rules for the projects this team usually works on. Add a target's test,
 * build and lint commands here, or pass them per run with --allow.
 */
export const DEFAULT_ALLOWED_TOOLS: readonly string[] = [];

const RULE = /^[A-Za-z][\w-]*(\(.+\))?$/;

/**
 * A bare tool name grants every use of it. For these tools that would hand
 * every command or path to the regex hook alone, so they need a specifier.
 */
const NEEDS_SPECIFIER = new Set<string>(["Bash", ...WRITE_TOOLS]);

/** A write specifier rooted at / or ~ with nothing but wildcards after it. */
const WHOLE_FILESYSTEM = /^\((\/{1,2}|~\/?)[*/]*\)$/;

function validate(rule: string): string {
  const trimmed = rule.trim();
  if (!RULE.test(trimmed)) {
    throw new Error(
      `Invalid allow rule "${rule}". Expected a tool name with an optional specifier, e.g. "Bash(pnpm test:*)".`,
    );
  }
  const tool = trimmed.replace(/\(.*/s, "");
  const specifier = trimmed.slice(tool.length);
  // A specifier made only of wildcards and separators names nothing, so it
  // grants every call just like a bare tool name.
  if (NEEDS_SPECIFIER.has(trimmed) || /\([\s*:?,]*\)$/.test(trimmed)) {
    throw new Error(
      `Allow rule "${rule}" would grant every ${tool} call. Name the command or path, e.g. "${tool}(pnpm test:*)".`,
    );
  }
  if (
    (WRITE_TOOLS as readonly string[]).includes(tool) &&
    WHOLE_FILESYSTEM.test(specifier)
  ) {
    throw new Error(
      `Allow rule "${rule}" covers the whole filesystem. Scope it to a path in the project, e.g. "${tool}(src/**)".`,
    );
  }
  // The safety hook runs before allow rules are consulted, so a rule for a
  // command it blocks would only mislead whoever reads the command line.
  // A prefix rule is rejected only when the commands it extends to are
  // blocked too (`rm -rf:*`); `env:*` also covers `env FOO=1 pnpm test`, so
  // it is kept, with a warning from allowRuleWarnings().
  if (tool === "Bash") {
    const body = specifier.slice(1, -1);
    const command = body.replace(/(:\*|\s*\*)$/, "");
    const isPrefix = command !== body;
    const blocked =
      bashDenyReason(command) !== null &&
      (!isPrefix || bashDenyReason(`${command} x`) !== null)
        ? bashDenyReason(command)
        : null;
    if (blocked !== null) {
      throw new Error(
        `Allow rule "${rule}" can never take effect: the team's safety policy blocks that command whatever the allow rules say. ${blocked}`,
      );
    }
  }
  return trimmed;
}

/**
 * Suffixes that turn an ordinary command into one the safety policy blocks.
 * A prefix rule such as "Bash(rm:*)" is valid, since plain `rm file` is
 * allowed, but it also matches these, and the operator should know they stay
 * blocked.
 */
const DENIED_SUFFIXES = ["--force", "--hard", "-D x", "-rf x"];

/**
 * Warnings for valid Bash prefix rules that also match commands the safety
 * policy blocks. Best-effort: it tries a few common suffixes, not every
 * spelling.
 */
export function allowRuleWarnings(rules: readonly string[]): string[] {
  return rules.flatMap((rule) => {
    const match = /^Bash\((.+?)(?::\*|\s*\*)\)$/s.exec(rule.trim());
    if (!match) return [];
    const command = match[1]!.trim();
    const example = DENIED_SUFFIXES.map((suffix) => `${command} ${suffix}`).find(
      (candidate) => bashDenyReason(candidate) !== null,
    );
    return example === undefined
      ? []
      : [
          `Allow rule "${rule}" also matches commands the safety policy blocks, such as "${example}"; those stay blocked whatever the allow rules say.`,
        ];
  });
}

/** The run's allow rules, validated once, with what they mean for reads. */
export interface AllowRules {
  /** Passed to the SDK as `allowedTools`. */
  readonly allowedTools: readonly string[];
  /** Real directories (or files) outside --cwd that Read, Grep and Glob may reach. */
  readonly readRoots: readonly string[];
  /**
   * Rules that do less than they look like (a read rule that opens nothing,
   * a path that cannot be resolved). They change what the team can do, so
   * --strict counts them.
   */
  readonly warnings: readonly string[];
  /**
   * Information only: a Bash prefix rule that also matches commands the
   * safety policy blocks. The rule works as written; --strict ignores these.
   */
  readonly notices: readonly string[];
}

const READ_RULE = /^(Read|Grep|Glob)\((.+)\)$/s;

function realOrResolved(path: string, warnings: string[]): string {
  try {
    return realpathSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      warnings.push(
        `Could not resolve ${path} (${code ?? (error as Error).message}); it is used as written.`,
      );
    }
    return resolve(path);
  }
}

const isWithin = (root: string, path: string) =>
  path === root || path.startsWith(root === sep ? sep : root + sep);

/**
 * Where a Read/Grep/Glob rule path points, with Claude Code's permission-rule
 * semantics: `//path` is absolute, `~/path` is under the home directory, and
 * a single leading `/path` or a bare `path` is relative to the project.
 */
function rulePath(path: string, cwd: string, home: string): string {
  if (path.startsWith("//")) return resolve(path.slice(1));
  if (path === "~" || path.startsWith("~/")) return resolve(home, `.${path.slice(1)}`);
  return resolve(cwd, path.replace(/^\/+/, ""));
}

/**
 * The read root a Read/Grep/Glob rule opens outside --cwd: its directory when
 * the specifier is a path, optionally ending in `/**`. Throws for a root that
 * would open the filesystem, the home directory or a parent of the project,
 * and for `dir/*`, which in a rule covers only the files directly in `dir`
 * (the policy opens whole trees, so it cannot honor one level).
 */
function readRuleRoot(
  rule: string,
  specifier: string,
  cwd: string,
  home: string,
  warnings: string[],
): string | undefined {
  const spec = specifier.trim();
  const tree = /(^|\/)\*\*$/.test(spec);
  const oneLevel = !tree && /(^|\/)\*$/.test(spec);
  const path = spec.replace(/(^|\/)\*\*?$/, "$1") || ".";
  const wild = /[?*[{]/.test(path);
  // The part before the first wildcard says whether the rule leaves the project.
  const fixed = wild ? path.slice(0, path.search(/[?*[{]/)).replace(/[^/]*$/, "") : path;
  const target = realOrResolved(rulePath(fixed || ".", cwd, home), warnings);
  if (isWithin(cwd, target)) return undefined;
  if (wild) {
    warnings.push(
      `Allow rule "${rule}" names no single directory, so reads it matches outside the project still need approval (and are denied under --yes). Name the directory, e.g. "Read(//abs/dir/**)".`,
    );
    return undefined;
  }
  if (target === sep || isWithin(target, cwd) || isWithin(target, home)) {
    throw new Error(
      `Allow rule "${rule}" would open ${target} to reads without approval: that is the whole filesystem, the home directory or a parent of the project. Name a directory outside the project, e.g. "Read(//opt/docs/**)".`,
    );
  }
  if (oneLevel) {
    const tool = rule.replace(/\(.*/s, "");
    throw new Error(
      `Allow rule "${rule}" covers only the files directly in ${target}, and the safety policy can only open a whole directory to reads. Use "${tool}(/${target}/**)" to allow the directory tree.`,
    );
  }
  return target;
}

/**
 * Validates the run's allow rules once and derives what they open to reads.
 * Throws on a rule the policy refuses. `cwd` and `home` are resolved through
 * symlinks before any comparison.
 */
export function prepareAllowRules(
  defaults: readonly string[],
  extra: readonly string[],
  options: { cwd: string; home?: string },
): AllowRules {
  const allowedTools = resolveAllowedTools(defaults, extra);
  const notices = allowRuleWarnings(allowedTools);
  const warnings: string[] = [];
  const cwd = realpathSync(options.cwd);
  const home = realOrResolved(options.home ?? homedir(), warnings);
  const readRoots = allowedTools.flatMap((rule) => {
    const match = READ_RULE.exec(rule);
    if (!match) return [];
    const root = readRuleRoot(rule, match[2]!, cwd, home, warnings);
    return root === undefined ? [] : [root];
  });
  return Object.freeze({
    allowedTools: Object.freeze(allowedTools),
    readRoots: Object.freeze([...new Set(readRoots)]),
    warnings: Object.freeze(warnings),
    notices: Object.freeze(notices),
  });
}

export function resolveAllowedTools(
  defaults: readonly string[],
  extra: readonly string[],
): string[] {
  const rules = [...defaults, ...extra].map(validate);
  return [...new Set([...BASE_ALLOWED_TOOLS, ...rules])];
}
