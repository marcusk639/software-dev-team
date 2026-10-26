import { reviewer, TEAM_PLUGIN_NAME, type AgentSpec } from "../shared.js";

export const agent: AgentSpec = {
  description:
    "Reviews code changes for correctness, security and maintainability, rating each finding by severity and confidence. Use on every implementation alongside qa-tester, and again on each round of fixes until it reports clean.",
  // Judge tier, like qa-tester: it decides what blocks a change, and cheap-tier
  // judges miss more defects.
  model: "opus",
  ...reviewer(),
  // The review method (scope, checks by kind of code, ratings, scorecard,
  // re-review) lives in the team plugin's skill; the prompt keeps the role
  // and the report format the manager relies on.
  skills: [`${TEAM_PLUGIN_NAME}:code-review`],
  promptFile: new URL("./prompt.md", import.meta.url),
};
