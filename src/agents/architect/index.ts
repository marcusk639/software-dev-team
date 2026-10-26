import { ADVISORY_MAX_TURNS, advisory, type AgentSpec } from "../shared.js";

export const agent: AgentSpec = {
  description:
    "Designs system structure and makes technical tradeoff decisions. Use before implementing anything that spans more than one module, and for any change to data flow, boundaries, or dependencies.",
  model: "opus",
  tools: advisory(),
  maxTurns: ADVISORY_MAX_TURNS,
  promptFile: new URL("./prompt.md", import.meta.url),
};
