import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildJsonResult, parseManagerReport } from "./report.js";

describe("parseManagerReport", () => {
  it("reads the outcome from the manager's first section", () => {
    assert.deepEqual(
      parseManagerReport(
        "1. **Outcome**: done. Export shipped.\n2. **What changed**: …",
      ),
      { outcome: "done" },
    );
    assert.equal(
      parseManagerReport("**Outcome:** partial — tests blocked").outcome,
      "partial",
    );
    assert.equal(
      parseManagerReport("Outcome: blocked, emulator refused").outcome,
      "blocked",
    );
  });

  it("reads needs-decision and the question the manager asked last", () => {
    const report = [
      "1. **Outcome**: needs-decision, the refund rule is ambiguous.",
      "2. **What changed**: nothing yet.",
      "6. **Question**: Should partial refunds keep the platform fee?",
    ].join("\n");
    assert.deepEqual(parseManagerReport(report), {
      outcome: "needs-decision",
      question: "Should partial refunds keep the platform fee?",
    });
  });

  it("ignores a question section that says there is none", () => {
    const report = "1. **Outcome**: done.\n6. **Question**: none";
    assert.deepEqual(parseManagerReport(report), { outcome: "done" });
  });

  it("is unknown when the report has no outcome line", () => {
    assert.deepEqual(parseManagerReport("I finished the work."), {
      outcome: "unknown",
    });
    assert.equal(parseManagerReport("").outcome, "unknown");
  });

  it("takes the first outcome, not one quoted later in the report", () => {
    const report =
      "1. **Outcome**: partial.\n3. **Evidence**: qa said `Outcome: done`";
    assert.equal(parseManagerReport(report).outcome, "partial");
  });
});

describe("buildJsonResult", () => {
  const base = {
    summary: {
      result: "1. **Outcome**: done.",
      isError: false,
      turns: 12,
      durationMs: 3400,
      costUsd: 1.25,
      sessionId: "s-1",
      received: true,
      subtype: "success",
      permissionDenials: [],
    },
    exitCode: 0,
    strict: true,
    needsCheck: false,
    warning: undefined,
    profileChain: ["recovery-platform", "regroup"],
    ledger: [],
    ledgerFaults: 0,
    warnings: [],
    notices: [],
    changedFiles: ["regroup/functions/src/a.ts"],
    acceptanceTests: ["regroup/functions/src/__tests__/export.test.ts"],
  };

  it("carries the fields claude -p --output-format json puts at the top level", () => {
    const json = buildJsonResult(base);
    assert.equal(json.type, "result");
    assert.equal(json.subtype, "success");
    assert.equal(json.is_error, false);
    assert.equal(json.result, "1. **Outcome**: done.");
    assert.equal(json.session_id, "s-1");
    assert.equal(json.num_turns, 12);
    assert.equal(json.duration_ms, 3400);
    assert.equal(json.total_cost_usd, 1.25);
    assert.deepEqual(json.permission_denials, []);
  });

  it("adds the team's outcome, profile, evidence and changed files", () => {
    const json = buildJsonResult(base);
    assert.equal(json.team.outcome, "done");
    assert.equal(json.team.question, null);
    assert.deepEqual(json.team.profile, ["recovery-platform", "regroup"]);
    assert.equal(json.team.exit_code, 0);
    assert.deepEqual(json.team.changed_files, ["regroup/functions/src/a.ts"]);
    assert.equal(json.team.needs_check, false);
  });

  it("reports a run with no result message as an error with subtype no_result", () => {
    const json = buildJsonResult({
      ...base,
      summary: {
        ...base.summary,
        received: false,
        isError: true,
        result: "The run ended without a result; it may not have finished.",
        subtype: undefined,
      },
      exitCode: 1,
    });
    assert.equal(json.subtype, "no_result");
    assert.equal(json.is_error, true);
    assert.equal(json.team.outcome, "unknown");
  });

  it("is serializable with a null cost when none was reported", () => {
    const { costUsd: _, ...summary } = base.summary;
    const json = buildJsonResult({ ...base, summary });
    assert.equal(json.total_cost_usd, null);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(json)));
  });
});

describe("the manager's suggested commit message", () => {
  it("is read from its own line, without code quotes", () => {
    const report = "1. **Outcome**: done.\n7. **Commit message**: `feat(regroup-functions): export payment history as CSV`";
    assert.equal(parseManagerReport(report).commitMessage, "feat(regroup-functions): export payment history as CSV");
  });

  it("is absent when the report has none or says none", () => {
    assert.equal(parseManagerReport("1. **Outcome**: done.").commitMessage, undefined);
    assert.equal(parseManagerReport("**Commit message**: none").commitMessage, undefined);
  });
});

describe("buildJsonResult: review material", () => {
  it("lists the acceptance tests and the suggested commit message", () => {
    const json = buildJsonResult({
      summary: {
        result: "1. **Outcome**: done.\n7. **Commit message**: fix(recovery-api): reject empty referral ids",
        isError: false, turns: 1, durationMs: 1, received: true, subtype: "success", permissionDenials: [],
      },
      exitCode: 0, strict: false, needsCheck: false, warning: undefined, profileChain: ["generic"],
      ledger: [], ledgerFaults: 0, warnings: [], notices: [], changedFiles: [], acceptanceTests: ["t.test.ts"],
    });
    assert.deepEqual(json.team.acceptance_tests, ["t.test.ts"]);
    assert.equal(json.team.commit_message, "fix(recovery-api): reject empty referral ids");
  });
});

describe("buildJsonResult: a failed run never reads as success", () => {
  it("reports error_during_execution when the SDK says success but is_error is set", () => {
    const json = buildJsonResult({
      summary: {
        result: "Not logged in · Please run /login", isError: true, turns: 1, durationMs: 1,
        received: true, subtype: "success", permissionDenials: [],
      },
      exitCode: 1, strict: false, needsCheck: false, warning: undefined, profileChain: ["generic"],
      ledger: [], ledgerFaults: 0, warnings: [], notices: [], changedFiles: null, acceptanceTests: [],
    });
    assert.equal(json.subtype, "error_during_execution");
    assert.equal(json.is_error, true);
  });
});

describe("parseManagerReport: review round 1", () => {
  it("does not read a question out of prose that starts with the word", () => {
    const report = "1. **Outcome**: done\n5. Questions about scope were resolved.\n7. **Question**: none";
    assert.equal(parseManagerReport(report).question, undefined);
  });

  it("keeps a question only when the outcome waits on the user", () => {
    const ask = "\n7. **Question**: Should refunds keep the fee?";
    assert.equal(parseManagerReport(`1. **Outcome**: needs-decision.${ask}`).question, "Should refunds keep the fee?");
    assert.equal(parseManagerReport(`1. **Outcome**: blocked, a refused command.${ask}`).question, "Should refunds keep the fee?");
    assert.equal(parseManagerReport(`1. **Outcome**: done.${ask}`).question, undefined);
  });

  it("reads an outcome only as a whole word", () => {
    assert.equal(parseManagerReport("1. **Outcome**: done-ish").outcome, "unknown");
    assert.equal(parseManagerReport("1. **Outcome**: partially").outcome, "unknown");
    assert.equal(parseManagerReport("1. **Outcome**: done.").outcome, "done");
    assert.equal(parseManagerReport("1. **Outcome**: done, all green").outcome, "done");
  });

  it("needs the label's colon for a commit message", () => {
    assert.equal(parseManagerReport("1. **Outcome**: done\nCommit messages follow the scope rule.").commitMessage, undefined);
  });
});

