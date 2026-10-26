import { implementer, type AgentSpec } from "../shared.js";

export const agent: AgentSpec = {
  description:
    "Implements web UI, client state, and browser-side data fetching. Use for any change to a web-facing surface.",
  model: "sonnet",
  ...implementer(),
  promptFile: new URL("./prompt.md", import.meta.url),
};
