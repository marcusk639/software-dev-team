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

export const IMPLEMENTER = [...READ_ONLY, "Write", "Edit", "Bash"] as const;

/**
 * A reviewer reads the change and runs checks (git diff, the type check, the
 * tests) but cannot edit, so its findings and the engineer's fix stay separate
 * artifacts. No web tools: the review is of the repository.
 */
export const REVIEWER = ["Read", "Grep", "Glob", "Bash"] as const;

/**
 * Turn caps per delegation. The manager's --max-turns does not bound a
 * specialist's own loop, so each role gets a ceiling that leaves room for
 * real work while stopping a specialist that is going in circles.
 */
export const ADVISORY_MAX_TURNS = 30;
export const IMPLEMENTER_MAX_TURNS = 60;

export const advisory = (tools: readonly string[] = READ_ONLY) => [...tools];
