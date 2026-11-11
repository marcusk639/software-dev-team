import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { ToolName } from "../tools.js";

/**
 * Project-specific changes to one role. Applied over a team role from
 * `team.ts`, or, for a name no team role has, defining a new role — in which
 * case `description`, `model`, `tools`, `identity` and `core` become required.
 *
 * Across an `extends` chain, scalar fields are overridden by the child, while
 * `expertise`, `standards` and `context` accumulate parent-first, so a child
 * profile adds to what its parent says rather than repeating it.
 */
export interface RoleOverlay {
  /** `false` removes the role from the team. */
  enabled?: boolean;
  /** Replaces the routing description the manager reads. */
  description?: string;
  model?: NonNullable<AgentDefinition["model"]>;
  tools?: readonly ToolName[];
  /** Defaults to the team role's cap, or for a new role to the cap of its tool set. */
  maxTurns?: number;
  /** Replaces the role's `<role>` section: who it is on this project. */
  identity?: string;
  /**
   * Replaces the role's `<standards>` and drops its `<workflow>`, where the
   * stack-neutral ones do not fit the stack. Its output format and
   * verification stay, so the report the manager reads keeps its shape.
   */
  core?: string;
  /** Replaces the role's `<output_format>`; a new role should set one. */
  outputFormat?: string;
  /** Technologies and techniques the role is a specialist in. */
  expertise?: readonly string[];
  /** Project-specific practices the role must follow. */
  standards?: readonly string[];
  /** Paths, commands and gotchas, including which docs to read first. */
  context?: string;
}

export interface ProjectProfile {
  /** Stable identifier used by `--profile` and by `extends`. */
  id: string;
  /** Human-readable project name, rendered into every prompt. */
  name: string;
  /** One line shown by `--profiles`. */
  summary: string;
  /** Id of a profile this one specializes. */
  extends?: string;
  /**
   * True when `cwd` belongs to this project. Used to pick a profile when none
   * is named; among matches, the one with the longest `extends` chain wins.
   */
  detect?: (cwd: string) => boolean;
  /** Facts every agent and the manager receive. */
  context?: string;
  /** Delegation rules for the manager, appended to its general routing. */
  routing?: readonly string[];
  roles?: Readonly<Record<string, RoleOverlay>>;
}
