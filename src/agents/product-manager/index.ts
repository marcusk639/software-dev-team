import { ADVISORY_MAX_TURNS, advisory, type AgentSpec } from "../shared.js";

export const agent: AgentSpec = {
  description:
    "Turns a vague request into a scoped, testable specification. Use FIRST on any new feature, and whenever requirements are ambiguous or scope is growing.",
  model: "opus",
  tools: advisory(),
  maxTurns: ADVISORY_MAX_TURNS,
  promptFile: new URL("./prompt.md", import.meta.url),
};
