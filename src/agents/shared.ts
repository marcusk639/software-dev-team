import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { ToolName } from "../tools.js";

/** An agent's definition minus its prompt text, which lives in a markdown file. */
export interface AgentSpec
  extends Omit<AgentDefinition, "prompt" | "model" | "maxTurns"> {
  promptFile: URL;
  /** Required: each role's tier is deliberate, and pinned against overrides. */
  model: NonNullable<AgentDefinition["model"]>;
  /** Required: --max-turns bounds only the manager, not a specialist's loop. */
  maxTurns: number;
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
] as const satisfies readonly ToolName[];

export const IMPLEMENTER = [
  ...READ_ONLY,
  "Write",
  "Edit",
  "Bash",
] as const satisfies readonly ToolName[];

/**
 * A reviewer reads the change and runs checks (git diff, the type check, the
 * tests) but cannot edit, so its findings and the engineer's fix stay separate
 * artifacts. No web tools: the review is of the repository.
 */
export const REVIEWER = [
  "Read",
  "Grep",
  "Glob",
  "Bash",
] as const satisfies readonly ToolName[];

/**
 * Turn caps per delegation. The manager's --max-turns does not bound a
 * specialist's own loop, so each role gets a ceiling that leaves room for
 * real work while stopping a specialist that is going in circles.
 */
export const ADVISORY_MAX_TURNS = 30;
export const IMPLEMENTER_MAX_TURNS = 60;

/** The tools and turn cap of a role that reads and advises but changes nothing. */
export const advisory = () => ({
  tools: [...READ_ONLY],
  maxTurns: ADVISORY_MAX_TURNS,
});

/** The tools and turn cap of a role that writes code and runs commands. */
export const implementer = () => ({
  tools: [...IMPLEMENTER],
  maxTurns: IMPLEMENTER_MAX_TURNS,
});

/**
 * The tools and turn cap of a reviewer: it reads and runs checks but cannot
 * edit, and reading a diff and running checks takes as many turns as
 * implementing one.
 */
export const reviewer = () => ({
  tools: [...REVIEWER],
  maxTurns: IMPLEMENTER_MAX_TURNS,
});
/**
 * The plugin shipped in this repo (plugin/), loaded into every run. Roles
 * preload its skills by `<name>:<skill>` instead of repeating a method in
 * their prompts. It travels with the repo, so a Docker image gets it with
 * the rest of the source.
 */
export const TEAM_PLUGIN_NAME = "dev-team";
export const TEAM_PLUGIN_DIR = new URL("../../plugin/", import.meta.url);
