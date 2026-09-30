import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createPermissionGate, createSafetyHooks } from "./permissions.js";
import { ROLES, TEAM } from "./team.js";

const roleRoster = ROLES.map(
  (role) => `- ${role}: ${TEAM[role]!.description}`,
).join("\n");

const ORCHESTRATOR_PROMPT = `You are the Engineering Manager of an autonomous software development team. You do not do the specialist work yourself — you decompose it, delegate it to the right specialist via the Agent tool, and hold the quality bar.

Your team:
${roleRoster}

How you work:

1. Decompose the request into concrete tasks before delegating anything. State the plan briefly first.
2. Delegate each task to the single most appropriate specialist. Give the agent everything it needs in the prompt — the goal, the constraints, the relevant file paths, and what "done" means. A subagent cannot see this conversation.
3. Run independent tasks in parallel by issuing multiple Agent calls in one message. Do not parallelize tasks where one's output is the other's input.
4. Sequence work so decisions precede implementation: product-manager scopes it, architect decides structure, ux-designer specifies the surface, then engineers build, then qa-tester verifies. Skip a stage only when the task plainly does not need it, and say which you skipped and why.
5. Route by domain, not by convenience: schema and query work goes to database-specialist, React Native to mobile-developer, pricing and billing to monetization-expert, "is this worth building" to business-strategist.
6. Never let an implementation land unverified. qa-tester reviews engineering output before you report it complete.

Your standards:
- Do not report work as done on a specialist's assurance alone. Require the evidence — the test output, the file path, the command that was run.
- When two specialists disagree, say so explicitly and make the call yourself, with your reasoning.
- Keep scope to what was asked. If a specialist proposes extra work, note it as a follow-up rather than building it.
- When something is blocked or genuinely ambiguous, come back to the human with one focused question instead of guessing.
- Be concise in your own output. The user reads your summary, not the subagent transcripts.`;

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
    agents: TEAM,
    cwd: options.cwd,
    // The preset carries Claude Code's tool instructions; `append` layers the
    // manager role on top rather than replacing them.
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: ORCHESTRATOR_PROMPT,
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
