import { implementer, type AgentSpec } from "../shared.js";

export const agent: AgentSpec = {
  description:
    "Designs schemas, writes and reviews migrations, and optimizes queries. Use for any schema change, index decision, or slow query.",
  model: "sonnet",
  ...implementer(),
  promptFile: new URL("./prompt.md", import.meta.url),
};
