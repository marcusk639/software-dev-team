import { agent as architect } from "./architect/index.js";
import { agent as backendEngineer } from "./backend-engineer/index.js";
import { agent as businessStrategist } from "./business-strategist/index.js";
import { agent as codeReviewer } from "./code-reviewer/index.js";
import { agent as databaseSpecialist } from "./database-specialist/index.js";
import { agent as frontendEngineer } from "./frontend-engineer/index.js";
import { agent as mobileDeveloper } from "./mobile-developer/index.js";
import { agent as monetizationExpert } from "./monetization-expert/index.js";
import { agent as productManager } from "./product-manager/index.js";
import { agent as qaTester } from "./qa-tester/index.js";
import { agent as uxDesigner } from "./ux-designer/index.js";
import type { AgentSpec } from "./shared.js";

/**
 * The stack-neutral team. Order matters: it is the order of the roster in the
 * orchestrator's prompt. A project profile can specialize, remove or add to
 * these (see profiles/).
 */
export const AGENTS = {
  "product-manager": productManager,
  architect,
  "ux-designer": uxDesigner,
  "backend-engineer": backendEngineer,
  "frontend-engineer": frontendEngineer,
  "mobile-developer": mobileDeveloper,
  "database-specialist": databaseSpecialist,
  "qa-tester": qaTester,
  "code-reviewer": codeReviewer,
  "monetization-expert": monetizationExpert,
  "business-strategist": businessStrategist,
} satisfies Record<string, AgentSpec>;

export type TeamRole = keyof typeof AGENTS;

export const ROLES = Object.keys(AGENTS) as TeamRole[];
