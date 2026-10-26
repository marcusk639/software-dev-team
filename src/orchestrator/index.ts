import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { DEFAULT_ALLOWED_TOOLS, prepareAllowRules } from "../allowlist.js";
import { createLedger, type LedgerEntry } from "../ledger.js";
import {
  createPermissionGate,
  createPolicy,
  createSafetyHooks,
} from "../permissions.js";
import { loadProjectAgents } from "../project-agents.js";
import {
  EMPTY_SUMMARY,
  finishSummary,
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

const ROSTER = "{{roster}}";

/**
 * Rendered per run so edits to prompt.md take effect on the next run. The
 * built-in prompt, or a project's replacement of it, is rendered strictly, so
 * a stray `{{` there is an error. A section override only has {{roster}}
 * filled and keeps any other braces as literal text, as appended text does.
 */
export function loadOrchestratorPrompt(
  customizations: ReadonlyMap<string, PromptCustomization> = new Map(),
): string {
  const roster = ROLES.map(
    (role) => `- ${role}: ${AGENTS[role].description}`,
  ).join("\n");
  const custom = customizations.get(ORCHESTRATOR);
  const base =
    custom?.replace ?? loadPrompt(new URL("./prompt.md", import.meta.url));
  const placed =
    base.includes(ROSTER) ||
    Object.values(custom?.sections ?? {}).some((text) => text.includes(ROSTER));
  const sections =
    custom?.sections &&
    Object.fromEntries(
      Object.entries(custom.sections).map(([name, text]) => [
        name,
        text.split(ROSTER).join(roster),
      ]),
    );
  const body = customizeBody(
    renderPrompt(base, { roster }),
    sections && { sections },
    "The orchestrator prompt",
  );
  // Without the roster the manager cannot know which specialists exist; a
  // project replacing <team> or the whole prompt must keep the placeholder.
  if (!placed || !body.includes(roster)) {
    throw new Error(
      "The orchestrator prompt must include {{roster}}, which lists the team. Keep it in any replacement of the prompt or of its <team> section.",
    );
  }
  return withAppended(body, custom?.append);
}

/** Default turn ceiling for the manager on every run; override with --max-turns. */
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
  /** Configuration problems that do not stop the run, e.g. a rejected project agent. Defaults to console.warn. */
  onWarning?: ((warning: string) => void) | undefined;
}

export interface RunSummary extends Summary {
  /** What each role actually ran, recorded by the harness. */
  ledger: readonly Readonly<LedgerEntry>[];
  ledgerText: string;
  /**
   * Hook events or stream messages the ledger failed to record. Non-zero
   * means the ledger is incomplete; runOutcome treats it as needing a check.
   */
  ledgerFaults: number;
  /** The configuration warnings the run started with (also sent to onWarning). */
  warnings: readonly string[];
}

/**
 * Everything runTeam hands to query(), built without starting a run so the
 * wiring (hooks, permission mode, approval gate, pinned models, environment)
 * can be tested.
 */
export function prepareRun(options: RunOptions): {
  queryOptions: Options;
  ledger: ReturnType<typeof createLedger>;
  warnings: string[];
} {
  const project = loadProjectAgents(options.cwd);
  // Validated once; the read roots come from the same validated list.
  const rules = prepareAllowRules(DEFAULT_ALLOWED_TOOLS, options.allow ?? [], {
    cwd: options.cwd,
  });
  const policy = createPolicy({
    cwd: options.cwd,
    agents: [...ROLES, ...project.agents.map((agent) => agent.name)],
    // A project agent that declares a model gets the same protection as a
    // team role: the manager may not swap it for a cheaper or other model.
    pinnedModels: [
      ...ROLES.filter((role) => AGENTS[role].model !== undefined),
      ...project.agents.flatMap((agent) =>
        agent.model === undefined ? [] : [agent.name],
      ),
    ],
    readRoots: rules.readRoots,
    // Without --yes a human answers prompts, so a read outside --cwd is put
    // to them; unattended, it is denied.
    interactive: !options.autoApprove,
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
    allowedTools: [...rules.allowedTools],
    permissionMode: options.autoApprove ? "acceptEdits" : "default",
    hooks: {
      // Enforced in every mode, including --yes, and inside subagents.
      PreToolUse: [...ledger.hooks.PreToolUse, ...safety.PreToolUse],
      PostToolUse: ledger.hooks.PostToolUse,
      PostToolUseFailure: ledger.hooks.PostToolUseFailure,
    },
    // Installed only for interactive runs. Under --yes, a call that acceptEdits
    // and allowedTools don't approve is refused.
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
    // Every run gets a ceiling; an unattended one has no other brake.
    maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,
    ...(options.maxBudgetUsd === undefined
      ? {}
      : { maxBudgetUsd: options.maxBudgetUsd }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.resume === undefined ? {} : { resume: options.resume }),
  };

  return {
    queryOptions,
    ledger,
    warnings: [...project.warnings, ...rules.warnings],
  };
}

export async function runTeam(options: RunOptions): Promise<RunSummary> {
  const { queryOptions, ledger, warnings } = prepareRun(options);
  for (const warning of warnings) (options.onWarning ?? console.warn)(warning);

  const stream = query({ prompt: options.task, options: queryOptions });

  let summary: Summary = EMPTY_SUMMARY;
  try {
    for await (const message of stream) {
      // The result is folded first, so a fault in the side effects below
      // cannot lose it, and neither of them may end a run that is working.
      summary = foldMessage(summary, message);
      sideEffect("renderer", () => options.onMessage?.(message));
      // The ledger counts its own faults (ledger.faults()).
      ledger.observe(message);
    }
  } catch (error) {
    // The ledger is the evidence of what already ran; a failed stream must not lose it.
    summary = foldFailure(summary, error);
  }

  return {
    ...finishSummary(summary),
    ledger: ledger.entries(),
    ledgerText: ledger.format(),
    ledgerFaults: ledger.faults(),
    warnings: Object.freeze([...warnings]),
  };
}

function sideEffect(name: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    console.error(
      `The ${name} failed on a message and skipped it: ${(error as Error)?.message ?? String(error)}`,
    );
  }
}
