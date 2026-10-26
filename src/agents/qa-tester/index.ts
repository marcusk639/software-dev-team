import { IMPLEMENTER_MAX_TURNS, advisory, IMPLEMENTER, type AgentSpec } from "../shared.js";

export const agent: AgentSpec = {
  description:
    "Writes tests and adversarially hunts for defects in completed work. Use after any implementation, and before claiming something is done.",
  // Frontier tier on purpose. This is the Judge role - the last gate before work is
  // called done, and the verifier for payment-critical changes. Cheap-tier judges
  // measurably reduce defect recall (negation blindness); OpenAI built CriticGPT on
  // GPT-4-class capacity deliberately. Implementers stay on sonnet: route cheap for
  // mechanical, spec-complete work, never for the thing that catches error.
  model: "opus",
  tools: advisory([...IMPLEMENTER]),
  maxTurns: IMPLEMENTER_MAX_TURNS,
  promptFile: new URL("./prompt.md", import.meta.url),
};
