import type { ProjectProfile } from "./types.js";

/** The stack-neutral team, used when no project profile applies. */
export const generic: ProjectProfile = {
  id: "generic",
  name: "Generic",
  summary: "Stack-neutral specialists; no project-specific knowledge.",
};
