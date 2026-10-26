import { ADVISORY_MAX_TURNS, advisory, type AgentSpec } from "../shared.js";

export const agent: AgentSpec = {
  description:
    "Designs pricing, packaging, billing logic, and upgrade paths. Use for subscriptions, paywalls, feature gating, trials, or any revenue-affecting change.",
  model: "opus",
  tools: advisory(),
  maxTurns: ADVISORY_MAX_TURNS,
  promptFile: new URL("./prompt.md", import.meta.url),
};
