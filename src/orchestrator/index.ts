import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createPermissionGate, createSafetyHooks } from "../permissions.js";
import { loadPrompt, renderPrompt } from "../prompts.js";
import { AGENTS, loadTeam, ROLES } from "../team.js";

/** Rendered per run so edits to prompt.md take effect on the next run. */
export function loadOrchestratorPrompt(): string {
  const roster = ROLES.map(
    (role) => `- ${role}: ${AGENTS[role].description}`,
  ).join("\n");
  return renderPrompt(loadPrompt(new URL("./prompt.md", import.meta.url)), {
    roster,
  });
}

/** Ceiling for unattended runs; override with --max-turns. */
const DEFAULT_MAX_TURNS = 60;

export interface RunOptions {
  task: string;
  cwd: string;
  autoApprove: boolean;
  maxTurns?: number | undefined;
  model?: string | undefined;
  onMessage?: ((message: SDKMessage) => void) | undefined;
}

export interface RunSummary {
  result: string;
  isError: boolean;
  turns: number;
  durationMs: number;
  costUsd?: number;
  sessionId?: string;
}

export async function runTeam(options: RunOptions): Promise<RunSummary> {
  const queryOptions: Options = {
    agents: loadTeam(),
    cwd: options.cwd,
    // The preset carries Claude Code's tool instructions; `append` layers the
    // manager role on top rather than replacing them.
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: loadOrchestratorPrompt(),
    },
    tools: { type: "preset", preset: "claude_code" },
    permissionMode: options.autoApprove ? "acceptEdits" : "default",
    // Enforced in every mode, including --yes.
    hooks: createSafetyHooks(),
    // Only reached in interactive mode; acceptEdits auto-approves before this runs.
    ...(options.autoApprove ? {} : { canUseTool: createPermissionGate() }),
    // Loads the target checkout's .claude tree (needed for its CLAUDE.md and
    // agents). That makes --cwd a trust boundary: a repo's own settings.json
    // hooks and .mcp.json servers load with it. Its permissions.allow rules
    // cannot weaken createSafetyHooks() — a PreToolUse deny is authoritative,
    // verified against a target declaring allow:["Bash"] — but its hooks are
    // its own code. Point --cwd at repos you trust.
    settingSources: ["project"],
    // An unattended run has no interactive brake, so it always gets a ceiling.
    maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,
    ...(options.model === undefined ? {} : { model: options.model }),
  };

  const stream = query({ prompt: options.task, options: queryOptions });

  let summary: RunSummary = {
    result: "",
    isError: false,
    turns: 0,
    durationMs: 0,
  };

  for await (const message of stream) {
    options.onMessage?.(message);

    if (message.type === "result") {
      summary = {
        result:
          message.subtype === "success"
            ? message.result
            : `Run ended: ${message.subtype}`,
        isError: message.is_error,
        turns: message.num_turns,
        durationMs: message.duration_ms,
        costUsd: message.total_cost_usd,
        sessionId: message.session_id,
      };
    }
  }

  return summary;
}
