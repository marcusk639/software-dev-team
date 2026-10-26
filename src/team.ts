import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import { agent as architect } from "./agents/architect/index.js";
import { agent as backendEngineer } from "./agents/backend-engineer/index.js";
import { agent as businessStrategist } from "./agents/business-strategist/index.js";
import { agent as databaseSpecialist } from "./agents/database-specialist/index.js";
import { agent as frontendEngineer } from "./agents/frontend-engineer/index.js";
import { agent as mobileDeveloper } from "./agents/mobile-developer/index.js";
import { agent as monetizationExpert } from "./agents/monetization-expert/index.js";
import { agent as productManager } from "./agents/product-manager/index.js";
import { agent as qaTester } from "./agents/qa-tester/index.js";
import { agent as uxDesigner } from "./agents/ux-designer/index.js";
import type { AgentSpec } from "./agents/shared.js";
import {
  applyCustomization,
  customizeBody,
  loadPrompt,
  type PromptCustomization,
  withAppended,
} from "./prompts.js";

/**
 * The name a project uses to customize the conventions every specialist
 * shares (.claude/dev-team/team.md and friends).
 */
export const TEAM_CONVENTIONS = "team";

const CONVENTIONS_FILE = new URL("./agents/team/prompt.md", import.meta.url);

/** Order matters: it is the order of the roster in the orchestrator's prompt. */
export const AGENTS = {
  "product-manager": productManager,
  architect,
  "ux-designer": uxDesigner,
  "backend-engineer": backendEngineer,
  "frontend-engineer": frontendEngineer,
  "mobile-developer": mobileDeveloper,
  "database-specialist": databaseSpecialist,
  "qa-tester": qaTester,
  "monetization-expert": monetizationExpert,
  "business-strategist": businessStrategist,
} satisfies Record<string, AgentSpec>;

export type TeamRole = keyof typeof AGENTS;

export const ROLES = Object.keys(AGENTS) as TeamRole[];

/**
 * Reads every agent's prompt from disk with the target project's
 * customizations applied; call once per run. Each specialist's prompt is
 * composed of, in order: its own sections, the shared team conventions, and
 * the project's instructions for that role. The role's own project text comes
 * last so it can refine anything above it.
 */
export function loadTeam(
  customizations: ReadonlyMap<string, PromptCustomization> = new Map(),
): Record<TeamRole, AgentDefinition> {
  const conventions = applyCustomization(
    loadPrompt(CONVENTIONS_FILE),
    customizations.get(TEAM_CONVENTIONS),
    "Conventions from this project",
  );
  return Object.fromEntries(
    ROLES.map((role) => {
      const { promptFile, ...definition } = AGENTS[role];
      const custom = customizations.get(role);
      const body = customizeBody(
        loadPrompt(promptFile),
        custom,
        `The ${role} prompt`,
      );
      const prompt = withAppended(`${body}\n\n${conventions}`, custom?.append);
      return [role, { ...definition, prompt }];
    }),
  ) as Record<TeamRole, AgentDefinition>;
}
