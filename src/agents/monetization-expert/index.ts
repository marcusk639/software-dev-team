import { advisory, type AgentSpec } from "../shared.js";

export const agent: AgentSpec = {
  description:
    "Designs pricing, packaging, billing logic, and upgrade paths. Use for subscriptions, paywalls, feature gating, trials, or any revenue-affecting change.",
  model: "opus",
  ...advisory(),
  promptFile: new URL("./prompt.md", import.meta.url),
};
