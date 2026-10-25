import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";

/** An agent's definition minus its prompt text, which lives in a markdown file. */
export interface AgentSpec extends Omit<AgentDefinition, "prompt"> {
  promptFile: URL;
}

/**
 * Tool sets are deliberately narrow. A role that only needs to reason about code
 * should not be able to rewrite it — that is what keeps the architect's opinion
 * and the engineer's diff reviewable as separate artifacts.
 */
export const READ_ONLY = [
  "Read",
  "Grep",
  "Glob",
  "WebSearch",
  "WebFetch",
] as const;
export const IMPLEMENTER = [
  "Read",
  "Write",
  "Edit",
  "Grep",
  "Glob",
  "Bash",
] as const;

export const advisory = (tools: readonly string[] = READ_ONLY) => [...tools];
