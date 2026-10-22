/**
 * Project-specific changes to one role. Applied over a base role from
 * `roles/base.ts`, or, for a name no base role has, defining a new role — in
 * which case `description`, `identity` and `core` become required.
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
  model?: string;
  tools?: readonly string[];
  /** Replaces the base "You are …" line. */
  identity?: string;
  /** Replaces the base standards where they do not fit the stack. */
  core?: string;
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
