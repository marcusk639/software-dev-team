import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { DEFAULT_ALLOWED_TOOLS, resolveAllowedTools } from "../allowlist.js";
import { createLedger, type LedgerEntry } from "../ledger.js";
import {
  createPermissionGate,
  createPolicy,
  createSafetyHooks,
} from "../permissions.js";
import { projectAgentNames } from "../project-agents.js";
import {
  EMPTY_SUMMARY,
  foldFailure,
  foldMessage,
  type Summary,
} from "./summary.js";
import {
  customizeBody,
  loadCustomizations,
  loadPrompt,
  type PromptCustomization,
  renderPrompt,
  withAppended,
} from "../prompts.js";
import {
  AGENTS,
  loadTeam,
  ROLES,
  TEAM_CONVENTIONS,
  TEAM_PLUGIN_DIR,
} from "../team.js";

/** The name a project uses to customize the manager's prompt. */
export const ORCHESTRATOR = "orchestrator";

/** Every prompt a project may customize. */
export const PROMPT_NAMES: readonly string[] = [
  ORCHESTRATOR,
  TEAM_CONVENTIONS,
  ...ROLES,
];

/**
 * Rendered per run so edits to prompt.md take effect on the next run. A
 * project's replacement is rendered too, so it can place {{roster}}; appended
 * text is used verbatim.
 */
export function loadOrchestratorPrompt(
  customizations: ReadonlyMap<string, PromptCustomization> = new Map(),
): string {
  const roster = ROLES.map(
    (role) => `- ${role}: ${AGENTS[role].description}`,
  ).join("\n");
  const custom = customizations.get(ORCHESTRATOR);
  const template = customizeBody(
    loadPrompt(new URL("./prompt.md", import.meta.url)),
    custom,
    "The orchestrator prompt",
  );
  // Without the roster the manager cannot know which specialists exist; a
  // project replacing <team> or the whole prompt must keep the placeholder.
  if (!template.includes("{{roster}}")) {
    throw new Error(
      "The orchestrator prompt must include {{roster}}, which lists the team. Keep it in any replacement of the prompt or of its <team> section.",
    );
  }
  return withAppended(renderPrompt(template, { roster }), custom?.append);
}

/** Ceiling for unattended runs; override with --max-turns. */
const DEFAULT_MAX_TURNS = 60;

export interface RunOptions {
  task: string;
  cwd: string;
  autoApprove: boolean;
  /** Extra permission rules from --allow, on top of allowlist.ts. */
  allow?: readonly string[] | undefined;
  /** Session to continue; `task` is then the next user message. */
  resume?: string | undefined;
  maxTurns?: number | undefined;
  /** Stops the run once its estimated cost passes this many dollars. */
  maxBudgetUsd?: number | undefined;
  model?: string | undefined;
  onMessage?: ((message: SDKMessage) => void) | undefined;
}

export interface RunSummary extends Summary {
  /** What each role actually ran, recorded by the harness. */
  ledger: LedgerEntry[];
  ledgerText: string;
}

export async function runTeam(options: RunOptions): Promise<RunSummary> {
  const policy = createPolicy({
    cwd: options.cwd,
    agents: [...ROLES, ...projectAgentNames(options.cwd)],
    pinnedModels: ROLES.filter((role) => AGENTS[role].model !== undefined),
  });
  const ledger = createLedger({
    cwd: policy.cwd,
    secretValues: policy.secretValues,
  });
  const safety = createSafetyHooks(policy, ledger.block);
  const customizations = loadCustomizations(options.cwd, PROMPT_NAMES);

  const queryOptions: Options = {
    agents: loadTeam(customizations),
    cwd: options.cwd,
    // The preset carries Claude Code's tool instructions; `append` layers the
    // manager role on top rather than replacing them.
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: loadOrchestratorPrompt(customizations),
    },
    tools: { type: "preset", preset: "claude_code" },
    allowedTools: resolveAllowedTools(
      DEFAULT_ALLOWED_TOOLS,
      options.allow ?? [],
    ),
    permissionMode: options.autoApprove ? "acceptEdits" : "default",
    hooks: {
      // Enforced in every mode, including --yes, and inside subagents.
      PreToolUse: [...ledger.hooks.PreToolUse, ...safety.PreToolUse],
      PostToolUse: ledger.hooks.PostToolUse,
      PostToolUseFailure: ledger.hooks.PostToolUseFailure,
    },
    // Only reached in interactive mode; acceptEdits auto-approves before this runs.
    ...(options.autoApprove
      ? {}
      : { canUseTool: createPermissionGate(policy) }),
    // Loads the target checkout's .claude tree (needed for its CLAUDE.md and
    // agents). That makes --cwd a trust boundary: a repo's own settings.json
    // hooks and .mcp.json servers load with it. Its permissions.allow rules
    // cannot weaken createSafetyHooks() — a PreToolUse deny is authoritative,
    // verified against a target declaring allow:["Bash"] — but its hooks are
    // its own code. Point --cwd at repos you trust.
    settingSources: ["project"],
    // The team plugin carries the skills roles preload (e.g. code-review).
    plugins: [{ type: "local", path: fileURLToPath(TEAM_PLUGIN_DIR) }],
    // Takes general-purpose, Explore, Plan and the other built-in agents off
    // the manager's menu while keeping the team and the target's own agents.
    // Undocumented in sdk.d.ts; verified against 0.3.283. The delegation rule
    // in the safety hook is the enforcement either way.
    env: { ...process.env, CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1" },
    // An unattended run has no interactive brake, so it always gets a ceiling.
    maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,
    ...(options.maxBudgetUsd === undefined
      ? {}
      : { maxBudgetUsd: options.maxBudgetUsd }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.resume === undefined ? {} : { resume: options.resume }),
  };

  const stream = query({ prompt: options.task, options: queryOptions });

  let summary = EMPTY_SUMMARY;
  try {
    for await (const message of stream) {
      options.onMessage?.(message);
      ledger.observe(message);
      summary = foldMessage(summary, message);
    }
  } catch (error) {
    // The ledger is the evidence of what already ran; a failed stream must not lose it.
    summary = foldFailure(summary, error);
  }

  return { ...summary, ledger: ledger.entries(), ledgerText: ledger.format() };
}
