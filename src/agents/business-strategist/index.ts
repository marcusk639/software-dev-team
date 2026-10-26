import { ADVISORY_MAX_TURNS, advisory, type AgentSpec } from "../shared.js";

export const agent: AgentSpec = {
  description:
    "Decides whether work is worth doing: prioritization, build/buy/kill calls, competitive and market positioning. Use when deciding what to do next, or whether to stop.",
  model: "opus",
  tools: advisory(),
  maxTurns: ADVISORY_MAX_TURNS,
  promptFile: new URL("./prompt.md", import.meta.url),
};
