import { AGENTS } from "../agents/index.js";
import {
  ADVISORY_MAX_TURNS,
  type AgentSpec,
  IMPLEMENTER_MAX_TURNS,
} from "../agents/shared.js";
import { BUILT_IN_AGENTS, RESERVED_NAMES } from "../project-agents.js";
import { generic } from "./generic.js";
import type { ProjectProfile, RoleOverlay } from "./types.js";

/**
 * One specialist on a resolved team: its definition, and the profile
 * material its prompt is rendered with (see loadTeam in team.ts).
 */
export interface TeamMember extends Omit<AgentSpec, "promptFile"> {
  /** The built-in prompt; absent for a role the profile introduces. */
  promptFile?: URL;
  overlay: RoleOverlay;
}

/** A profile chain flattened into the team the orchestrator runs. */
export interface ResolvedProfile {
  /** The selected profile, most specific. */
  profile: ProjectProfile;
  /** Ids from root ancestor to the selected profile. */
  chain: string[];
  /** Shared context, parent-first; empty when no profile in the chain sets it. */
  context: string;
  routing: string[];
  /** In roster order: team roles first, then roles the profile adds. */
  members: Record<string, TeamMember>;
}

/**
 * Walks `extends` from `id` to its root. Throws on an unknown id or a cycle,
 * since either would silently drop the context the user asked for.
 */
export function profileChain(
  id: string,
  available: ReadonlyMap<string, ProjectProfile>,
): ProjectProfile[] {
  const chain: ProjectProfile[] = [];
  const seen = new Set<string>();
  let next: string | undefined = id;
  while (next !== undefined) {
    if (seen.has(next)) {
      throw new Error(
        `Profile "${id}" has an extends cycle through "${next}".`,
      );
    }
    seen.add(next);
    const profile = available.get(next);
    if (!profile) {
      throw new Error(
        next === id
          ? `Unknown profile "${id}".`
          : `Profile "${chain[0]?.id ?? id}" extends unknown profile "${next}".`,
      );
    }
    chain.unshift(profile);
    next = profile.extends;
  }
  return chain;
}

export function joinBlocks(...blocks: Array<string | undefined>): string {
  return blocks
    .map((block) => block?.trim())
    .filter((block): block is string => Boolean(block))
    .join("\n\n");
}

function mergeOverlay(parent: RoleOverlay, child: RoleOverlay): RoleOverlay {
  const merged: RoleOverlay = { ...parent, ...child };
  const expertise = [...(parent.expertise ?? []), ...(child.expertise ?? [])];
  const standards = [...(parent.standards ?? []), ...(child.standards ?? [])];
  const context = joinBlocks(parent.context, child.context);
  if (expertise.length) merged.expertise = expertise;
  if (standards.length) merged.standards = standards;
  if (context) merged.context = context;
  return merged;
}

/** Lower-case, no dots: the name is also a .claude/dev-team file name. */
const ROLE_NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Names a profile may not give a new role: the prompts a project customizes
 * besides the roles, the ledger's own role names, and Claude Code's built-in
 * agents, which the safety policy keeps off the manager's menu.
 */
const UNAVAILABLE = new Set(
  ["orchestrator", "team", ...RESERVED_NAMES, ...BUILT_IN_AGENTS].map((n) =>
    n.toLowerCase(),
  ),
);

const WRITES = new Set(["Write", "Edit", "Bash"]);

function newMember(
  name: string,
  profile: ProjectProfile,
  overlay: RoleOverlay,
): TeamMember {
  const { description, model, tools, identity, core } = overlay;
  if (!description || !model || !tools || !identity || !core) {
    throw new Error(
      `Role "${name}" in profile "${profile.id}" is not a team role, so it must define description, model, tools, identity and core.`,
    );
  }
  if (!ROLE_NAME.test(name) || UNAVAILABLE.has(name)) {
    throw new Error(
      `Profile "${profile.id}" cannot add a role named "${name}": use lower-case letters, digits and dashes, and not a reserved or built-in agent name.`,
    );
  }
  return {
    description,
    model,
    tools: [...tools],
    maxTurns:
      overlay.maxTurns ??
      (tools.some((tool) => WRITES.has(tool))
        ? IMPLEMENTER_MAX_TURNS
        : ADVISORY_MAX_TURNS),
    overlay,
  };
}

export function composeProfile(
  chain: readonly ProjectProfile[],
): ResolvedProfile {
  const profile = chain.at(-1);
  if (!profile) throw new Error("Cannot compose a team from an empty chain.");

  const context = joinBlocks(...chain.map((p) => p.context));
  const routing = chain.flatMap((p) => p.routing ?? []);

  const overlays = new Map<string, RoleOverlay>();
  for (const p of chain) {
    for (const [name, overlay] of Object.entries(p.roles ?? {})) {
      overlays.set(name, mergeOverlay(overlays.get(name) ?? {}, overlay));
    }
  }

  const base: Readonly<Record<string, AgentSpec>> = AGENTS;
  // Team roles keep their order; roles a profile introduces follow them.
  const names = [
    ...Object.keys(base),
    ...[...overlays.keys()].filter((name) => !Object.hasOwn(base, name)),
  ];

  const members: Record<string, TeamMember> = {};
  for (const name of names) {
    const overlay = overlays.get(name) ?? {};
    if (overlay.enabled === false) continue;
    const spec = Object.hasOwn(base, name) ? base[name] : undefined;
    if (!spec) {
      members[name] = newMember(name, profile, overlay);
      continue;
    }
    members[name] = {
      ...spec,
      ...(overlay.description === undefined
        ? {}
        : { description: overlay.description }),
      ...(overlay.model === undefined ? {} : { model: overlay.model }),
      ...(overlay.tools === undefined ? {} : { tools: [...overlay.tools] }),
      ...(overlay.maxTurns === undefined ? {} : { maxTurns: overlay.maxTurns }),
      overlay,
    };
  }

  if (Object.keys(members).length === 0) {
    throw new Error(`Profile "${profile.id}" disables every role.`);
  }

  return {
    profile,
    chain: chain.map((p) => p.id),
    context,
    routing,
    members,
  };
}

/** The stack-neutral team, with no profile material. */
export function genericProfile(): ResolvedProfile {
  return composeProfile([generic]);
}
