import { ledgerConcerns, type LedgerEntry } from "./ledger.js";

/** Exit code when the run finished but --strict found ledger entries to check. */
export const STRICT_EXIT = 3;

/**
 * The process exit code and the warning line for a finished run: 1 when the
 * run failed (including one that ended without a result), otherwise 0, or
 * STRICT_EXIT under --strict when the ledger records failed, blocked,
 * refused, background or unsettled calls. A failure that a later ok run
 * of the same command superseded is shown but does not count.
 */
export function runOutcome(
  summary: { readonly isError: boolean; readonly ledger: readonly LedgerEntry[] },
  strict: boolean,
): { code: number; warning: string | undefined } {
  const { warning, needsCheck } = ledgerConcerns(summary.ledger);
  const code = summary.isError
    ? 1
    : strict && needsCheck
      ? STRICT_EXIT
      : 0;
  return { code, warning };
}
