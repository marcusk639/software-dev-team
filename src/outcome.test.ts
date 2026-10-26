import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LedgerEntry } from "./ledger.js";
import { runOutcome } from "./outcome.js";

const entry = (outcome: LedgerEntry["outcome"]): LedgerEntry =>
  ({
    toolUseId: outcome,
    role: "qa-tester",
    tool: "Bash",
    detail: "pnpm test",
    outcome,
    ...(outcome === "failed" || outcome === "started" ? { note: "n" } : {}),
  }) as LedgerEntry;

describe("runOutcome (C3, I9e)", () => {
  it("exits 0 for a clean run", () => {
    assert.deepEqual(runOutcome({ isError: false, ledger: [entry("ok")] }, false), {
      code: 0,
      warning: undefined,
    });
  });

  it("exits 1 when the run failed, including a run with no result", () => {
    assert.equal(runOutcome({ isError: true, ledger: [] }, false).code, 1);
  });

  it("warns, but exits 0, when the ledger has calls to check and --strict is off", () => {
    const outcome = runOutcome({ isError: false, ledger: [entry("ok"), entry("started")] }, false);
    assert.equal(outcome.code, 0);
    assert.match(outcome.warning ?? "", /1 left running in the background/);
  });

  for (const outcome of ["failed", "blocked", "refused", "started", "unfinished"] as const) {
    it(`exits 3 under --strict when the ledger has a ${outcome} call`, () => {
      assert.equal(runOutcome({ isError: false, ledger: [entry(outcome)] }, true).code, 3);
    });
  }

  it("keeps exit 1 for a failed run under --strict", () => {
    assert.equal(runOutcome({ isError: true, ledger: [entry("failed")] }, true).code, 1);
  });
});
