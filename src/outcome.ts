import { ledgerConcerns, type LedgerEntry } from "./ledger.js";

/** Exit code when the run finished but --strict found something to check. */
export const STRICT_EXIT = 3;

/** What runOutcome reads from a finished run. */
export interface RunRecord {
  readonly isError: boolean;
  readonly ledger: readonly LedgerEntry[];
  /** Hook events or stream messages the ledger failed to record. */
  readonly ledgerFaults?: number | undefined;
  /** Configuration warnings the run printed (rejected project agents, allow rules). */
  readonly warnings?: readonly string[] | undefined;
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/**
 * The process exit code and the warning lines for a finished run: 1 when the
 * run failed (including one that ended without a result), otherwise 0, or
 * STRICT_EXIT under --strict when the ledger records failed, blocked,
 * refused, background or unsettled calls, when the ledger itself missed
 * events, or when the run printed configuration warnings. A Bash failure
 * that a later ok run of the same command by the same agent superseded is
 * shown but does not count. The warning is printed with or without --strict.
 */
export function runOutcome(
  summary: RunRecord,
  strict: boolean,
): { code: number; warning: string | undefined } {
  const concerns = ledgerConcerns(summary.ledger);
  const faults = summary.ledgerFaults ?? 0;
  const warnings = summary.warnings?.length ?? 0;
  const lines = [
    concerns.warning,
    faults > 0 &&
      `Warning: the ledger failed to record ${plural(faults, "hook event or message", "hook events or messages")}, so its record of this run is incomplete.`,
    warnings > 0 &&
      `Warning: the run started with ${plural(warnings, "configuration warning")} (repeated above); a rejected agent or rule may have changed what the team could do.`,
  ].filter((line): line is string => typeof line === "string");
  const needsCheck = concerns.needsCheck || faults > 0 || warnings > 0;
  const code = summary.isError ? 1 : strict && needsCheck ? STRICT_EXIT : 0;
  return { code, warning: lines.length === 0 ? undefined : lines.join("\n") };
}
