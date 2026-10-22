import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { composeTeam, profileChain, type ResolvedTeam } from "./compose.js";
import { generic } from "./generic.js";
import { recoveryPlatform } from "./recovery-platform.js";
import { regroup } from "./regroup/index.js";
import type { ProjectProfile } from "./types.js";

export const BUILT_IN_PROFILES: readonly ProjectProfile[] = [
  generic,
  recoveryPlatform,
  regroup,
];

export const DEFAULT_PROFILE_ID = generic.id;

function registry(extra: readonly ProjectProfile[] = []) {
  const map = new Map<string, ProjectProfile>();
  for (const profile of [...BUILT_IN_PROFILES, ...extra]) {
    map.set(profile.id, profile);
  }
  return map;
}

/**
 * The most specific profile whose `detect` matches `cwd`: among matches, the
 * one with the longest `extends` chain, so a product profile beats the
 * monorepo profile it extends. Falls back to the generic profile.
 */
export function detectProfileId(
  cwd: string,
  profiles: readonly ProjectProfile[] = BUILT_IN_PROFILES,
): string {
  const available = registry(profiles);
  let best: { id: string; depth: number } | undefined;
  for (const profile of profiles) {
    if (!profile.detect?.(cwd)) continue;
    const depth = profileChain(profile.id, available).length;
    if (!best || depth > best.depth) best = { id: profile.id, depth };
  }
  return best?.id ?? DEFAULT_PROFILE_ID;
}

function isProfile(value: unknown): value is ProjectProfile {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    typeof record.summary === "string"
  );
}

/** Imports a profile module from disk; its default export is the profile. */
async function importProfile(path: string): Promise<ProjectProfile> {
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    throw new Error(`Profile file not found: ${absolute}`);
  }
  const module = (await import(pathToFileURL(absolute).href)) as {
    default?: unknown;
  };
  if (!isProfile(module.default)) {
    throw new Error(
      `${absolute} must default-export a profile with string id, name and summary.`,
    );
  }
  return module.default;
}

function looksLikePath(selector: string): boolean {
  return /[\\/]/.test(selector) || /\.[cm]?[jt]s$/.test(selector);
}

export interface ProfileSelection {
  /** A built-in id or a path to a profile module. Omit to detect from `cwd`. */
  selector?: string | undefined;
  cwd: string;
}

export async function resolveTeam(
  selection: ProfileSelection,
): Promise<ResolvedTeam> {
  const { selector, cwd } = selection;
  if (selector !== undefined && looksLikePath(selector)) {
    const external = await importProfile(selector);
    return composeTeam(profileChain(external.id, registry([external])));
  }
  const id = selector ?? detectProfileId(cwd);
  return composeTeam(profileChain(id, registry()));
}
