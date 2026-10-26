import {
  IMPLEMENTER_MAX_TURNS,
  advisory,
  REVIEWER,
  type AgentSpec,
} from "../shared.js";

export const agent: AgentSpec = {
  description:
    "Reviews code changes for correctness, security and maintainability, rating each finding by severity and confidence. Use on every implementation alongside qa-tester, and again on each round of fixes until it reports clean.",
  // Judge tier, like qa-tester: it decides what blocks a change, and cheap-tier
  // judges miss more defects.
  model: "opus",
  tools: advisory(REVIEWER),
  // Reading a diff and running checks takes as many turns as implementing one.
  maxTurns: IMPLEMENTER_MAX_TURNS,
  promptFile: new URL("./prompt.md", import.meta.url),
};
