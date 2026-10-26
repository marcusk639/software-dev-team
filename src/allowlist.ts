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
 *   "mcp__server__tool"
 */

import { homedir } from "node:os";
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

/**
 * Directories that Read, Grep or Glob allow rules name, e.g.
 * "Read(//Users/me/notes/**)" or "Grep(~/docs/**)". Reads there need no
 * approval even though they are outside --cwd. A leading `//` or `/` is an
 * absolute path, `~/` the home directory; a specifier with wildcards before
 * its last segment names no single directory and is ignored.
 */
export function readRootsFromAllowRules(
  rules: readonly string[],
  home: string = homedir(),
): string[] {
  return rules.flatMap((rule) => {
    const match = /^(?:Read|Grep|Glob)\((.+)\)$/s.exec(rule.trim());
    if (!match) return [];
    let path = match[1]!.trim().replace(/\/\*\*?$|\*\*$/, "");
    if (path.startsWith("~/") || path === "~") path = home + path.slice(1);
    else if (path.startsWith("//")) path = path.slice(1);
    else if (!path.startsWith("/")) return [];
    if (/[?*[{]/.test(path)) return [];
    return [path.replace(/\/+$/, "") || "/"];
  });
}

export function resolveAllowedTools(
  defaults: readonly string[],
  extra: readonly string[],
): string[] {
  const rules = [...defaults, ...extra].map(validate);
  return [...new Set([...BASE_ALLOWED_TOOLS, ...rules])];
}
