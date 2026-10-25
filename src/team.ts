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
import { loadPrompt } from "./prompts.js";

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

/** Reads every agent's prompt from disk; call once per run. */
export function loadTeam(): Record<TeamRole, AgentDefinition> {
  return Object.fromEntries(
    ROLES.map((role) => {
      const { promptFile, ...definition } = AGENTS[role];
      return [role, { ...definition, prompt: loadPrompt(promptFile) }];
    }),
  ) as Record<TeamRole, AgentDefinition>;
}
