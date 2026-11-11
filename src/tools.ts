/**
 * Built-in tool names the team's policy refers to. Lists of tools are checked
 * against this with `satisfies`, so a typo or a renamed tool fails typecheck
 * instead of silently dropping out of a rule.
 */
export type ToolName =
  | "Read"
  | "Grep"
  | "Glob"
  | "Write"
  | "Edit"
  | "MultiEdit"
  | "NotebookEdit"
  | "Bash"
  | "Agent"
  | "Task"
  | "TodoWrite"
  | "ToolSearch"
  | "WebSearch"
  | "WebFetch";

/** Tools that write a file. One list, used by the safety hook and the allowlist. */
export const WRITE_TOOLS = [
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
] as const satisfies readonly ToolName[];

export const DELEGATION_TOOLS = [
  "Agent",
  "Task",
] as const satisfies readonly ToolName[];

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
export const MANAGER_ALLOWED = [
  "Read",
  "Grep",
  "Glob",
  "Agent",
  "Task",
  "TodoWrite",
  "ToolSearch",
] as const satisfies readonly ToolName[];

/** True when `name` is on `list`, narrowing it to the list's names. */
export const isOneOf = <T extends string>(
  list: readonly T[],
  name: string,
): name is T => (list as readonly string[]).includes(name);

/** True for a plain object, the only shape a tool input may have. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
