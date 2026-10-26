import { advisory, type AgentSpec } from "../shared.js";

export const agent: AgentSpec = {
  description:
    "Designs user-facing flows, interaction states, and accessibility behavior. Use before building any screen, form, or user-visible surface.",
  model: "opus",
  tools: advisory(),
  promptFile: new URL("./prompt.md", import.meta.url),
};
