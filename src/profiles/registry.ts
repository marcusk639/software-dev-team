import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  composeProfile,
  profileChain,
  type ResolvedProfile,
} from "./compose.js";
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

export async function resolveProfile(
  selection: ProfileSelection,
): Promise<ResolvedProfile> {
  const { selector, cwd } = selection;
  if (selector !== undefined && looksLikePath(selector)) {
    const external = await importProfile(selector);
    return composeProfile(profileChain(external.id, registry([external])));
  }
  const id = selector ?? detectProfileId(cwd);
  return composeProfile(profileChain(id, registry()));
}

/**
 * Refuses a --cwd the profile's paths are not relative to (see
 * ProjectProfile.root), with the flags that would work instead.
 */
export function checkProfileRoot(profile: ResolvedProfile, cwd: string): void {
  if (!profile.root) return;
  const here = resolve(cwd);
  const root = profile.root(here);
  if (root === null) {
    throw new Error(
      `--cwd ${here} is not inside the project profile "${profile.profile.id}" is for (${profile.profile.name}).`,
    );
  }
  if (resolve(root) !== here) {
    throw new Error(
      `Profile "${profile.profile.id}" gives paths relative to the project root, ${root}, so the team must run there rather than in ${relative(root, here) || "."}. Use --cwd ${root} --profile ${profile.profile.id}.`,
    );
  }
}

