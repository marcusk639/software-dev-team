import type {
  HookCallbackMatcher,
  HookInput,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { relative } from "node:path";
import { actorOf } from "./permissions.js";
import { DELEGATION_TOOLS, isOneOf, type ToolName } from "./tools.js";

interface EntryBase {
  readonly toolUseId: string;
  /** The role that made the call; "manager" for the orchestrator itself, "unknown" when the call was never seen to start. */
  readonly role: string;
  readonly agentId?: string | undefined;
  readonly tool: string;
  readonly detail: string;
  readonly durationMs?: number | undefined;
  /**
   * Set when the call was settled without a PreToolUse record, so its role
   * and detail may be incomplete and the safety hook may not have seen it.
   */
  readonly noPreToolUseRecord?: true | undefined;
}

/**
 * One call and how it ended. `note` is a reason written by the harness or the
 * first line of an error message, never tool output.
 */
export type LedgerEntry =
  | (EntryBase & { readonly outcome: "ok"; readonly note?: undefined })
  /** Returned at once while the work went on in the background; its result is not known. */
  | (EntryBase & { readonly outcome: "started"; readonly note: string })
  | (EntryBase & { readonly outcome: "failed"; readonly note: string })
  | (EntryBase & {
      readonly outcome: "blocked" | "refused";
      readonly note?: string | undefined;
    })
  /** Never settled: refused after the hooks ran, still running, or not run. */
  | (EntryBase & { readonly outcome: "unfinished"; readonly note?: undefined });

export type Outcome = LedgerEntry["outcome"];

/** The ledger's working copy; callers only ever see frozen LedgerEntry snapshots. */
type Draft = { -readonly [K in keyof EntryBase]: EntryBase[K] } & {
  outcome: Outcome;
  note?: string | undefined;
};

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

const MAX_EVIDENCE_LINES = 30;

/**
 * Tools whose successful calls are left out as noise: they only read or plan.
 * Everything else is recorded, so a write through MultiEdit or an MCP tool
 * from the target's .mcp.json still shows up as evidence.
 */
const NOT_RECORDED: ReadonlySet<string> = new Set([
  "Read",
  "Grep",
  "Glob",
  "TodoWrite",
  "ToolSearch",
  "WebSearch",
] as const satisfies readonly ToolName[]);

/** Outcomes the manager and the operator must see, however long the record. */
const NEEDS_ATTENTION: ReadonlySet<Outcome> = new Set<Outcome>([
  "failed",
  "blocked",
  "refused",
  "started",
  "unfinished",
]);

const BACKGROUND_NOTE =
  "ran in the background; the harness did not see it finish";

type LedgerEvent = "PreToolUse" | "PostToolUse" | "PostToolUseFailure";

/** True when a call returned before its work finished (see FOREGROUND_ONLY in permissions.ts). */
function ranInBackground(
  tool: string,
  input: unknown,
  response: unknown,
): boolean {
  const res = (response ?? {}) as Record<string, unknown>;
  if (tool === "Bash") {
    // The safety hook forces run_in_background off, but a command that hits
    // its timeout, or one the user backgrounds, still returns a task id.
    return (
      typeof res.backgroundTaskId === "string" ||
      (input as { run_in_background?: unknown } | null)?.run_in_background ===
        true
    );
  }
  return isOneOf(DELEGATION_TOOLS, tool) && res.status === "async_launched";
}

/**
 * A record, written by the harness rather than the model, of what each role
 * actually ran and how it ended, so "tests pass" in a report can be checked
 * against a command and its outcome. It holds commands, paths and outcomes,
 * plus the first line of a failure or refusal message as a note; never other
 * tool output. Credential values are redacted.
 */
export function createLedger(options: {
  cwd: string;
  secretValues: readonly string[];
}) {
  const byId = new Map<string, Draft>();
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
    if (isOneOf(DELEGATION_TOOLS, tool))
      return `→ ${str(input.subagent_type) || "(untyped)"}`;
    const path =
      str(input.file_path) ||
      str(input.notebook_path) ||
      str(input.path) ||
      str(input.pattern) ||
      str(input.url);
    return path.startsWith("/") ? relative(options.cwd, path) || "." : path;
  }

  function draftFor(
    input: Partial<Pick<HookInput, "agent_id" | "agent_type">> & {
      tool_use_id: string;
      tool_name: string;
      tool_input?: unknown;
    },
  ): Draft {
    const actor = actorOf(input);
    return {
      toolUseId: input.tool_use_id,
      role: actor.kind === "manager" ? "manager" : actor.type,
      agentId: actor.kind === "manager" ? undefined : actor.id,
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
    };
  }

  /**
   * Settles a call. One the ledger never saw start is still recorded, flagged,
   * so a gap in the hooks shows up as a gap rather than as nothing.
   */
  function settle(
    id: string,
    outcome: Exclude<Outcome, "unfinished">,
    note: string | undefined,
    unseen: () => Draft,
  ): Draft | undefined {
    let entry = byId.get(id);
    if (!entry) {
      entry = { ...unseen(), noPreToolUseRecord: true };
      byId.set(id, entry);
    }
    if (entry.outcome !== "unfinished") return undefined;
    entry.outcome = outcome;
    if (note) entry.note = printable(redact(note));
    return entry;
  }

  const unseenCall = (tool: string, id: string) => (): Draft => ({
    toolUseId: id,
    role: "unknown",
    tool,
    detail: "",
    outcome: "unfinished",
  });

  const handler = async (input: HookInput) => {
    switch (input.hook_event_name) {
      case "PreToolUse": {
        byId.set(input.tool_use_id, draftFor(input));
        const early = earlyBlocks.get(input.tool_use_id);
        if (early !== undefined) {
          earlyBlocks.delete(input.tool_use_id);
          settle(input.tool_use_id, "blocked", early, () => draftFor(input));
        }
        break;
      }
      case "PostToolUse": {
        const background = ranInBackground(
          input.tool_name,
          input.tool_input,
          input.tool_response,
        );
        const entry = settle(
          input.tool_use_id,
          background ? "started" : "ok",
          background ? BACKGROUND_NOTE : undefined,
          () => draftFor(input),
        );
        if (entry) entry.durationMs = input.duration_ms;
        if (isOneOf(DELEGATION_TOOLS, input.tool_name)) {
          const agentId = (
            input.tool_response as { agentId?: unknown } | null | undefined
          )?.agentId;
          return {
            hookSpecificOutput: {
              hookEventName: "PostToolUse" as const,
              additionalContext:
                typeof agentId === "string" && !background
                  ? evidenceFor(agentId)
                  : "Harness record unavailable for this delegation; treat the report as unverified.",
            },
          };
        }
        break;
      }
      case "PostToolUseFailure": {
        const error = String(
          (input as { error?: unknown }).error ?? "unknown error",
        );
        settle(input.tool_use_id, "failed", error.split("\n")[0], () =>
          draftFor(input),
        );
        break;
      }
    }
    return { continue: true };
  };

  function snapshot(entry: Draft): LedgerEntry {
    return Object.freeze({ ...entry }) as LedgerEntry;
  }

  function recorded(): Draft[] {
    return [...byId.values()].filter(
      (e) =>
        !NOT_RECORDED.has(e.tool) ||
        e.outcome === "blocked" ||
        e.outcome === "refused",
    );
  }

  /** Frozen snapshots, in the order the calls started. */
  function entries(): LedgerEntry[] {
    return recorded().map(snapshot);
  }

  /**
   * What one specialist actually did, as recorded by the hooks, for the
   * manager to set against the specialist's own report. Only harness fields
   * go in (tool, command or path, outcome, and the first line of a failure
   * or refusal message); never other tool output, which is untrusted text.
   * Rows that need attention are always listed; the rest of the space goes
   * to the most recent calls.
   */
  function evidenceFor(agentId: string): string {
    const rows = recorded().filter((e) => e.agentId === agentId);
    if (rows.length === 0) {
      return "Harness record for this delegation: no recorded commands or file changes (reads are not recorded).";
    }
    const keep = new Set(rows.filter((e) => NEEDS_ATTENTION.has(e.outcome)));
    for (
      let i = rows.length - 1;
      i >= 0 && keep.size < MAX_EVIDENCE_LINES;
      i -= 1
    ) {
      keep.add(rows[i]!);
    }
    const lines = rows
      .filter((e) => keep.has(e))
      .map((e) => {
        const detail =
          e.detail.length > 120 ? `${e.detail.slice(0, 119)}…` : e.detail;
        // When the delegation has returned, a call with no outcome never ran:
        // its refusal can reach the stream after this hook fires.
        const outcome =
          e.outcome === "unfinished"
            ? "no result recorded (refused or not run)"
            : e.outcome;
        const nested = isOneOf(DELEGATION_TOOLS, e.tool)
          ? " (nested delegation; its own calls are not listed here)"
          : "";
        return `- ${e.tool} ${detail}: ${outcome}${e.note ? ` (${e.note.slice(0, 120)})` : ""}${nested}`;
      });
    const omitted = rows.length - keep.size;
    const more =
      omitted > 0 ? [`- and ${omitted} more earlier calls that ended ok`] : [];
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
      if (byId.has(toolUseId))
        settle(toolUseId, "blocked", reason, unseenCall("", toolUseId));
      else earlyBlocks.set(toolUseId, reason);
    },

    /** Feed every stream message through; picks up refusals the hooks never see. */
    observe(message: SDKMessage): void {
      if (
        message.type === "system" &&
        message.subtype === "permission_denied"
      ) {
        settle(
          message.tool_use_id,
          "refused",
          message.decision_reason,
          unseenCall(message.tool_name, message.tool_use_id),
        );
      } else if (message.type === "result") {
        for (const denial of message.permission_denials ?? []) {
          settle(
            denial.tool_use_id,
            "refused",
            undefined,
            unseenCall(denial.tool_name, denial.tool_use_id),
          );
        }
      }
    },

    entries,

    format(): string {
      const rows = recorded().map((e) => {
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
        const flag = e.noPreToolUseRecord ? " (no PreToolUse record)" : "";
        return [
          who,
          e.tool,
          e.detail.length > 80 ? `${e.detail.slice(0, 79)}…` : e.detail,
          `${result}${flag}`,
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

export interface LedgerConcerns {
  readonly counts: Readonly<
    Record<"failed" | "blocked" | "refused" | "started" | "unfinished", number>
  >;
  /** Failures that a later ok run of the same command by the same agent superseded. */
  readonly laterPassed: number;
  /** True when an entry needs the operator's attention (what --strict fails on). */
  readonly needsCheck: boolean;
  /** One line for the operator, or undefined when every recorded call ended ok. */
  readonly warning: string | undefined;
}

/**
 * Entries whose outcome means the run's report may claim more than the
 * harness saw. A failed command followed by an ok run of the same command
 * from the same agent is the red-then-green of TDD: it is reported as
 * "later passed" and does not count as needing a check.
 */
export function ledgerConcerns(
  entries: readonly LedgerEntry[],
): LedgerConcerns {
  const counts = {
    failed: 0,
    blocked: 0,
    refused: 0,
    started: 0,
    unfinished: 0,
  };
  let laterPassed = 0;
  entries.forEach((e, i) => {
    if (e.outcome === "ok") return;
    if (
      e.outcome === "failed" &&
      entries
        .slice(i + 1)
        .some(
          (later) =>
            later.outcome === "ok" &&
            later.agentId === e.agentId &&
            later.tool === e.tool &&
            later.detail === e.detail,
        )
    ) {
      laterPassed += 1;
      return;
    }
    counts[e.outcome] += 1;
  });
  const parts = [
    counts.failed && `${counts.failed} failed`,
    laterPassed && `${laterPassed} failed (later passed)`,
    counts.blocked && `${counts.blocked} blocked`,
    counts.refused && `${counts.refused} refused`,
    counts.started && `${counts.started} left running in the background`,
    counts.unfinished && `${counts.unfinished} with no result`,
  ].filter(Boolean);
  const needsCheck = Object.values(counts).some((n) => n > 0);
  return {
    counts,
    laterPassed,
    needsCheck,
    warning:
      parts.length === 0
        ? undefined
        : `Warning: the ledger records ${parts.join(", ")}.${needsCheck ? " Check those calls before trusting the report." : ""}`,
  };
}
