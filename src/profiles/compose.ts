import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import { BASE_ROLES } from "../roles/base.js";
import type { ProjectProfile, RoleOverlay } from "./types.js";

/** A profile chain flattened into the team the orchestrator runs. */
export interface ResolvedTeam {
  /** The selected profile, most specific. */
  profile: ProjectProfile;
  /** Ids from root ancestor to the selected profile. */
  chain: string[];
  /** Shared context, parent-first; empty when no profile in the chain sets it. */
  context: string;
  routing: string[];
  agents: Record<string, AgentDefinition>;
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

function joinBlocks(...blocks: Array<string | undefined>): string {
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

function bullets(heading: string, items: readonly string[] | undefined) {
  return items?.length
    ? `## ${heading}\n${items.map((item) => `- ${item}`).join("\n")}`
    : undefined;
}

function renderPrompt(
  identity: string,
  core: string,
  projectName: string,
  sharedContext: string,
  overlay: RoleOverlay,
): string {
  const project = joinBlocks(
    sharedContext && `## Project: ${projectName}\n\n${sharedContext}`,
    overlay.context && `## Your role on this project\n\n${overlay.context}`,
    bullets("Specialist expertise", overlay.expertise),
    bullets("Project standards", overlay.standards),
  );
  // With no project material this is exactly `identity\n\ncore`, so the
  // generic profile reproduces the original prompts byte for byte.
  return joinBlocks(identity, core, project);
}

export function composeTeam(chain: readonly ProjectProfile[]): ResolvedTeam {
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

  // Base roles keep their order; roles a profile introduces follow them.
  const names = [
    ...Object.keys(BASE_ROLES),
    ...[...overlays.keys()].filter((name) => !(name in BASE_ROLES)),
  ];

  const agents: Record<string, AgentDefinition> = {};
  for (const name of names) {
    const base = BASE_ROLES[name];
    const overlay = overlays.get(name) ?? {};
    if (overlay.enabled === false) continue;

    const description = overlay.description ?? base?.description;
    const identity = overlay.identity ?? base?.identity;
    const core = overlay.core ?? base?.core;
    if (!description || !identity || !core) {
      throw new Error(
        `Role "${name}" in profile "${profile.id}" is not a base role, so it must define description, identity and core.`,
      );
    }

    const model = overlay.model ?? base?.model;
    const tools = overlay.tools ?? base?.tools;
    agents[name] = {
      description,
      ...(model === undefined ? {} : { model }),
      ...(tools === undefined ? {} : { tools: [...tools] }),
      prompt: renderPrompt(identity, core, profile.name, context, overlay),
    };
  }

  if (Object.keys(agents).length === 0) {
    throw new Error(`Profile "${profile.id}" disables every role.`);
  }

  return {
    profile,
    chain: chain.map((p) => p.id),
    context,
    routing,
    agents,
  };
}
