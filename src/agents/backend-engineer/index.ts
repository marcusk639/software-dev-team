import { advisory, IMPLEMENTER, type AgentSpec } from "../shared.js";

export const agent: AgentSpec = {
  description:
    "Implements server-side APIs, business logic, background jobs, and integrations. Use for any work behind the network boundary.",
  model: "sonnet",
  tools: advisory(IMPLEMENTER),
  promptFile: new URL("./prompt.md", import.meta.url),
};
