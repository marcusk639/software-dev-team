import { implementer, type AgentSpec } from "../shared.js";

export const agent: AgentSpec = {
  description:
    "Implements React Native / Expo mobile features, native module integration, and offline behavior. Use for any iOS or Android app work.",
  model: "sonnet",
  ...implementer(),
  promptFile: new URL("./prompt.md", import.meta.url),
};
