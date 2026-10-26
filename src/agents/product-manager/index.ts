import { advisory, type AgentSpec } from "../shared.js";

export const agent: AgentSpec = {
  description:
    "Turns a vague request into a scoped, testable specification. Use FIRST on any new feature, and whenever requirements are ambiguous or scope is growing.",
  model: "opus",
  tools: advisory(),
  promptFile: new URL("./prompt.md", import.meta.url),
};
