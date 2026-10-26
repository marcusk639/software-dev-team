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
const NEEDS_SPECIFIER = new Set([
  "Bash",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);

function validate(rule: string): string {
  const trimmed = rule.trim();
  if (!RULE.test(trimmed)) {
    throw new Error(
      `Invalid allow rule "${rule}". Expected a tool name with an optional specifier, e.g. "Bash(pnpm test:*)".`,
    );
  }
  // A specifier made only of wildcards and separators names nothing, so it
  // grants every call just like a bare tool name.
  if (NEEDS_SPECIFIER.has(trimmed) || /\([\s*:?,]*\)$/.test(trimmed)) {
    throw new Error(
      `Allow rule "${rule}" would grant every ${trimmed.replace(/\(.*/, "")} call. Name the command or path, e.g. "${trimmed.replace(/\(.*/, "")}(pnpm test:*)".`,
    );
  }
  return trimmed;
}

export function resolveAllowedTools(
  defaults: readonly string[],
  extra: readonly string[],
): string[] {
  const rules = [...defaults, ...extra].map(validate);
  return [...new Set([...BASE_ALLOWED_TOOLS, ...rules])];
}
