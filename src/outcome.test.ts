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

describe("red then green: a failure a later run of the same command fixed", () => {
  const run = (
    id: string,
    outcome: "ok" | "failed",
    detail = "pnpm test",
    agentId = "a1",
  ): LedgerEntry =>
    ({
      toolUseId: id,
      role: "qa-tester",
      agentId,
      tool: "Bash",
      detail,
      outcome,
      ...(outcome === "failed" ? { note: "Exit code 1" } : {}),
    }) as LedgerEntry;

  it("does not trip --strict, and is shown as later passed", () => {
    const outcome = runOutcome(
      { isError: false, ledger: [run("1", "failed"), run("2", "ok")] },
      true,
    );
    assert.equal(outcome.code, 0);
    assert.match(outcome.warning ?? "", /1 failed \(later passed\)/);
    assert.doesNotMatch(outcome.warning ?? "", /Check those calls/);
  });

  it("still trips --strict when the last run of that command failed", () => {
    const outcome = runOutcome(
      {
        isError: false,
        ledger: [run("1", "failed"), run("2", "ok"), run("3", "failed")],
      },
      true,
    );
    assert.equal(outcome.code, 3);
    assert.match(outcome.warning ?? "", /1 failed, 1 failed \(later passed\)/);
  });

  it("does not count an ok of a different command or another agent", () => {
    for (const later of [run("2", "ok", "pnpm lint"), run("2", "ok", "pnpm test", "b2")]) {
      const outcome = runOutcome(
        { isError: false, ledger: [run("1", "failed"), later] },
        true,
      );
      assert.equal(outcome.code, 3);
      assert.match(outcome.warning ?? "", /^Warning: the ledger records 1 failed\./);
    }
  });
});

describe("I7: a degraded ledger and configuration warnings need a check", () => {
  it("trips --strict, with its own warning line, when the ledger missed events", () => {
    const outcome = runOutcome(
      { isError: false, ledger: [entry("ok")], ledgerFaults: 2, warnings: [] },
      true,
    );
    assert.equal(outcome.code, 3);
    assert.match(outcome.warning ?? "", /failed to record 2 hook events or messages/);
  });

  it("trips --strict when the run printed configuration warnings", () => {
    const outcome = runOutcome(
      {
        isError: false,
        ledger: [entry("ok")],
        ledgerFaults: 0,
        warnings: ["Project agent x.md is ignored: …"],
      },
      true,
    );
    assert.equal(outcome.code, 3);
    assert.match(outcome.warning ?? "", /1 configuration warning/);
  });

  it("warns without --strict and exits 0", () => {
    const outcome = runOutcome(
      { isError: false, ledger: [], ledgerFaults: 1, warnings: ["w"] },
      false,
    );
    assert.equal(outcome.code, 0);
    assert.match(outcome.warning ?? "", /failed to record 1 hook event/);
    assert.match(outcome.warning ?? "", /1 configuration warning/);
  });
});
