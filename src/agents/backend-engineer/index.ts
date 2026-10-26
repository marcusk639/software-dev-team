import { IMPLEMENTER_MAX_TURNS, advisory, IMPLEMENTER, type AgentSpec } from "../shared.js";

export const agent: AgentSpec = {
  description:
    "Implements server-side APIs, business logic, background jobs, and integrations. Use for any work behind the network boundary.",
  model: "sonnet",
  tools: advisory(IMPLEMENTER),
  maxTurns: IMPLEMENTER_MAX_TURNS,
  promptFile: new URL("./prompt.md", import.meta.url),
};
