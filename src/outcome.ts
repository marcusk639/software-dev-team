import { ledgerConcerns, type LedgerEntry } from "./ledger.js";

/** Exit code when the run finished but --strict found ledger entries to check. */
export const STRICT_EXIT = 3;

/**
 * The process exit code and the warning line for a finished run: 1 when the
 * run failed (including one that ended without a result), otherwise 0, or
 * STRICT_EXIT under --strict when the ledger records failed, blocked,
 * refused, background or unsettled calls.
 */
export function runOutcome(
  summary: { readonly isError: boolean; readonly ledger: readonly LedgerEntry[] },
  strict: boolean,
): { code: number; warning: string | undefined } {
  const { warning } = ledgerConcerns(summary.ledger);
  const code = summary.isError
    ? 1
    : strict && warning !== undefined
      ? STRICT_EXIT
      : 0;
  return { code, warning };
}
