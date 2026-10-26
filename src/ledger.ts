import type {
  HookCallbackMatcher,
  HookInput,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { relative } from "node:path";

export type Outcome = "ok" | "failed" | "blocked" | "refused" | "unfinished";

export interface LedgerEntry {
  /** The role that made the call; "manager" for the orchestrator itself. */
  role: string;
  agentId?: string | undefined;
  tool: string;
  detail: string;
  outcome: Outcome;
  note?: string | undefined;
  durationMs?: number | undefined;
}

/** Tools whose successful calls are evidence. Reads and searches are not recorded unless refused. */
/**
 * One line, without control characters: the ledger is printed to the
 * operator's terminal, and commands come from the model, so an escape
 * sequence in one must not reach the terminal or break the table.
 */
function printable(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim();
}

const DELEGATIONS = new Set(["Agent", "Task"]);
const MAX_EVIDENCE_LINES = 30;

/**
 * Tools whose successful calls are left out as noise: they only read or plan.
 * Everything else is recorded, so a write through MultiEdit or an MCP tool
 * from the target's .mcp.json still shows up as evidence.
 */
const NOT_RECORDED = new Set([
  "Read",
  "Grep",
  "Glob",
  "TodoWrite",
  "ToolSearch",
  "WebSearch",
]);

type LedgerEvent = "PreToolUse" | "PostToolUse" | "PostToolUseFailure";

/**
 * A record, written by the harness rather than the model, of what each role
 * actually ran and how it ended, so "tests pass" in a report can be checked
 * against a command and its outcome. It holds commands and paths only, never
 * tool output, and redacts credential values.
 */
export function createLedger(options: {
  cwd: string;
  secretValues: readonly string[];
}) {
  const byId = new Map<string, LedgerEntry>();
  // Hooks for one event may run concurrently, so a block can arrive before the call is recorded.
  const earlyBlocks = new Map<string, string>();

  const redact = (text: string) =>
    options.secretValues.reduce(
      (out, secret) => out.split(secret).join("[redacted]"),
      text,
    );

  function describe(tool: string, input: Record<string, unknown>): string {
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    if (tool === "Bash") return str(input.command).replace(/\s+/g, " ").trim();
    if (tool === "Agent" || tool === "Task")
      return `→ ${str(input.subagent_type) || "(untyped)"}`;
    const path =
      str(input.file_path) ||
      str(input.notebook_path) ||
      str(input.path) ||
      str(input.pattern) ||
      str(input.url);
    return path.startsWith("/") ? relative(options.cwd, path) || "." : path;
  }

  function settle(id: string, outcome: Outcome, note?: string): void {
    const entry = byId.get(id);
    if (!entry || entry.outcome !== "unfinished") return;
    entry.outcome = outcome;
    if (note) entry.note = printable(redact(note));
  }

  const handler = async (input: HookInput) => {
    switch (input.hook_event_name) {
      case "PreToolUse":
        byId.set(input.tool_use_id, {
          role: input.agent_type ?? "manager",
          agentId: input.agent_id,
          tool: input.tool_name,
          detail: printable(
            redact(
              describe(
                input.tool_name,
                (input.tool_input ?? {}) as Record<string, unknown>,
              ),
            ),
          ),
          outcome: "unfinished",
        });
        if (earlyBlocks.has(input.tool_use_id)) {
          settle(
            input.tool_use_id,
            "blocked",
            earlyBlocks.get(input.tool_use_id),
          );
          earlyBlocks.delete(input.tool_use_id);
        }
        break;
      case "PostToolUse": {
        settle(input.tool_use_id, "ok");
        const entry = byId.get(input.tool_use_id);
        if (entry) entry.durationMs = input.duration_ms;
        const agentId = (input.tool_response as { agentId?: unknown } | null)
          ?.agentId;
        if (DELEGATIONS.has(input.tool_name) && typeof agentId === "string") {
          return {
            hookSpecificOutput: {
              hookEventName: "PostToolUse" as const,
              additionalContext: evidenceFor(agentId),
            },
          };
        }
        break;
      }
      case "PostToolUseFailure":
        settle(input.tool_use_id, "failed", input.error.split("\n")[0]);
        break;
    }
    return { continue: true };
  };

  function entries(): LedgerEntry[] {
    return [...byId.values()].filter(
      (e) =>
        !NOT_RECORDED.has(e.tool) ||
        e.outcome === "blocked" ||
        e.outcome === "refused",
    );
  }

  /**
   * What one specialist actually did, as recorded by the hooks, for the
   * manager to set against the specialist's own report. Only harness fields
   * go in (tool, command or path, outcome); never tool output, which is
   * untrusted text.
   */
  function evidenceFor(agentId: string): string {
    const rows = entries().filter((e) => e.agentId === agentId);
    if (rows.length === 0) {
      return "Harness record for this delegation: no recorded commands or file changes (reads are not recorded).";
    }
    const lines = rows.slice(0, MAX_EVIDENCE_LINES).map((e) => {
      const detail =
        e.detail.length > 120 ? `${e.detail.slice(0, 119)}…` : e.detail;
      // When the delegation has returned, a call with no outcome never ran:
      // its refusal can reach the stream after this hook fires.
      const outcome =
        e.outcome === "unfinished"
          ? "no result recorded (refused or not run)"
          : e.outcome;
      const nested = DELEGATIONS.has(e.tool)
        ? " (nested delegation; its own calls are not listed here)"
        : "";
      return `- ${e.tool} ${detail}: ${outcome}${e.note ? ` (${e.note.slice(0, 120)})` : ""}${nested}`;
    });
    const more =
      rows.length > MAX_EVIDENCE_LINES
        ? [`- and ${rows.length - MAX_EVIDENCE_LINES} more`]
        : [];
    return [
      "Harness record for this delegation (recorded by the harness, not reported by the specialist). Check the specialist's claims against it:",
      ...lines,
      ...more,
    ].join("\n");
  }

  const hooks: Record<LedgerEvent, HookCallbackMatcher[]> = {
    PreToolUse: [{ hooks: [handler] }],
    PostToolUse: [{ hooks: [handler] }],
    PostToolUseFailure: [{ hooks: [handler] }],
  };

  return {
    hooks,

    /** Called by the safety hook when it denies a call. */
    block(toolUseId: string, reason: string): void {
      if (byId.has(toolUseId)) settle(toolUseId, "blocked", reason);
      else earlyBlocks.set(toolUseId, reason);
    },

    /** Feed every stream message through; picks up refusals the hooks never see. */
    observe(message: SDKMessage): void {
      if (
        message.type === "system" &&
        message.subtype === "permission_denied"
      ) {
        settle(message.tool_use_id, "refused", message.decision_reason);
      } else if (message.type === "result") {
        for (const denial of message.permission_denials) {
          settle(denial.tool_use_id, "refused");
        }
      }
    },

    entries,

    format(): string {
      const rows = entries().map((e) => {
        const who = e.agentId ? `${e.role}#${e.agentId.slice(0, 6)}` : e.role;
        const time =
          e.durationMs === undefined
            ? ""
            : ` ${(e.durationMs / 1000).toFixed(1)}s`;
        const result =
          e.outcome === "ok"
            ? `ok${time}`
            : e.note
              ? `${e.outcome}: ${redact(e.note).slice(0, 120)}`
              : e.outcome;
        return [
          who,
          e.tool,
          e.detail.length > 80 ? `${e.detail.slice(0, 79)}…` : e.detail,
          result,
        ];
      });
      if (rows.length === 0) return "";
      const widths = [0, 1, 2].map((i) =>
        Math.max(...rows.map((r) => r[i]!.length)),
      );
      return rows
        .map((r) =>
          r
            .map((cell, i) => (i < 3 ? cell.padEnd(widths[i]!) : cell))
            .join("  "),
        )
        .join("\n");
    },
  };
}
