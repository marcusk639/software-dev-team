import type { SDKPermissionDenial } from "@anthropic-ai/claude-agent-sdk";
import type { LedgerEntry } from "./ledger.js";
import type { Summary } from "./orchestrator/summary.js";

/** The manager's verdict on the run, from the first line of its report. */
export type TeamOutcome =
  "done" | "partial" | "blocked" | "needs-decision" | "unknown";

/**
 * A label at the start of a line, with its colon: `1. **Outcome**:`,
 * `**Outcome:**`, `Outcome:`. The colon is required, so prose that starts
 * with the same word ("Questions about scope…") is not a label.
 */
const label = (name: string, value: string, flags: string) =>
  new RegExp(
    String.raw`^[ \t]*(?:\d+\.[ \t]*)?(?:\*\*${name}(?::\*\*|\*\*[ \t]*:)|${name}[ \t]*:)[ \t]*${value}`,
    flags,
  );

/** The outcome word, whole: `done-ish` and `partially` are not outcomes. */
const OUTCOME = label(
  "Outcome",
  String.raw`(done|partial|blocked|needs-decision)(?![\w-])`,
  "im",
);
const QUESTION = label("Question", "(.+)$", "gim");
const COMMIT = label("Commit message", "(.+)$", "im");
const NONE = /^(?:none|n\/a|-|no question)\.?$/i;
/** The outcomes that wait on the user; only they carry a question. */
const ASKS: ReadonlySet<TeamOutcome> = new Set(["needs-decision", "blocked"]);

/**
 * Reads the manager's outcome and its question for the user, so an outer
 * orchestrator can decide between accepting the work, re-queuing it, and
 * resuming the session with an answer. The format is the manager's
 * <output_format>; a report that does not follow it is "unknown", never a
 * guessed success.
 */
export function parseManagerReport(text: string): {
  outcome: TeamOutcome;
  question?: string;
  /** The one-line conventional commit message the manager suggests. */
  commitMessage?: string;
} {
  const outcome = (OUTCOME.exec(text)?.[1]?.toLowerCase() ??
    "unknown") as TeamOutcome;
  const question = ASKS.has(outcome)
    ? [...text.matchAll(QUESTION)]
        .map((match) => match[1]!.trim())
        .filter((line) => line && !NONE.test(line))
        .at(-1)
    : undefined;
  const commit = COMMIT.exec(text)?.[1]
    ?.trim()
    .replace(/^`+|`+$/g, "")
    .trim();
  return {
    outcome,
    ...(question === undefined ? {} : { question }),
    ...(commit && !NONE.test(commit) ? { commitMessage: commit } : {}),
  };
}

export interface JsonResultInput {
  summary: Summary;
  exitCode: number;
  strict: boolean;
  needsCheck: boolean;
  warning: string | undefined;
  profileChain: readonly string[];
  ledger: readonly Readonly<LedgerEntry>[];
  ledgerFaults: number;
  warnings: readonly string[];
  notices: readonly string[];
  /** `git status` paths in --cwd after the run, or null outside a git checkout. */
  changedFiles: readonly string[] | null;
  /** The files qa-tester wrote: the run's acceptance contract. */
  acceptanceTests: readonly string[];
}

/**
 * One JSON object for an outer orchestrator. The top level carries the
 * fields `claude -p --output-format json` reports, under the same names, so a
 * dispatcher written for Claude Code reads it unchanged; `team` adds what
 * only this harness knows.
 */
export interface JsonResult {
  type: "result";
  subtype: string;
  is_error: boolean;
  result: string;
  session_id: string | null;
  num_turns: number;
  duration_ms: number;
  total_cost_usd: number | null;
  permission_denials: readonly SDKPermissionDenial[];
  team: {
    outcome: TeamOutcome;
    question: string | null;
    profile: readonly string[];
    exit_code: number;
    strict: boolean;
    needs_check: boolean;
    warning: string | null;
    warnings: readonly string[];
    notices: readonly string[];
    ledger: readonly Readonly<LedgerEntry>[];
    ledger_faults: number;
    changed_files: readonly string[] | null;
    acceptance_tests: readonly string[];
    commit_message: string | null;
  };
}

export function buildJsonResult(input: JsonResultInput): JsonResult {
  const { summary } = input;
  const report = parseManagerReport(summary.isError ? "" : summary.result);
  return {
    type: "result",
    // A failed run never reads as success, even when the SDK's own result
    // said so (an auth failure arrives as subtype success, is_error true).
    subtype:
      summary.isError && (summary.subtype ?? "success") === "success"
        ? summary.received
          ? "error_during_execution"
          : "no_result"
        : (summary.subtype ?? (summary.received ? "success" : "no_result")),
    is_error: summary.isError,
    result: summary.result,
    session_id: summary.sessionId ?? null,
    num_turns: summary.turns,
    duration_ms: summary.durationMs,
    total_cost_usd: summary.costUsd ?? null,
    permission_denials: summary.permissionDenials,
    team: {
      outcome: report.outcome,
      question: report.question ?? null,
      profile: input.profileChain,
      exit_code: input.exitCode,
      strict: input.strict,
      needs_check: input.needsCheck,
      warning: input.warning ?? null,
      warnings: input.warnings,
      notices: input.notices,
      ledger: input.ledger,
      ledger_faults: input.ledgerFaults,
      changed_files: input.changedFiles,
      acceptance_tests: input.acceptanceTests,
      commit_message: report.commitMessage ?? null,
    },
  };
}

/**
 * The result for a run that never started (bad arguments or configuration),
 * in the same shape as a finished run's so a typed reader needs no special
 * case: nothing ran, so the lists are empty and the unknowns null.
 */
export function buildStartupErrorResult(
  message: string,
  exitCode: number,
): JsonResult {
  return {
    type: "result",
    subtype: "error_startup",
    is_error: true,
    result: message,
    session_id: null,
    num_turns: 0,
    duration_ms: 0,
    total_cost_usd: null,
    permission_denials: [],
    team: {
      outcome: "unknown",
      question: null,
      profile: [],
      exit_code: exitCode,
      strict: false,
      needs_check: false,
      warning: null,
      warnings: [],
      notices: [],
      ledger: [],
      ledger_faults: 0,
      changed_files: null,
      acceptance_tests: [],
      commit_message: null,
    },
  };
}
