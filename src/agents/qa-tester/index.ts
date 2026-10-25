import { advisory, IMPLEMENTER, type AgentSpec } from "../shared.js";

export const agent: AgentSpec = {
  description:
    "Writes tests and adversarially hunts for defects in completed work. Use after any implementation, and before claiming something is done.",
  model: "sonnet",
  tools: advisory([...IMPLEMENTER]),
  promptFile: new URL("./prompt.md", import.meta.url),
};
