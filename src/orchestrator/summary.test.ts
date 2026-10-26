import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { EMPTY_SUMMARY, foldMessage, foldFailure } from "./summary.js";

const result = (fields: Record<string, unknown>) =>
  ({
    type: "result",
    subtype: "success",
    result: "ok",
    is_error: false,
    num_turns: 1,
    duration_ms: 1000,
    total_cost_usd: 0.01,
    session_id: "s1",
    ...fields,
  }) as unknown as SDKMessage;

describe("run summary", () => {
  it("takes the session id from the first message", () => {
    const summary = foldMessage(EMPTY_SUMMARY, { type: "system", subtype: "init", session_id: "s1" } as unknown as SDKMessage);
    assert.equal(summary.sessionId, "s1");
  });

  it("keeps an error from an earlier result when a later one succeeds", () => {
    let summary = foldMessage(EMPTY_SUMMARY, result({ subtype: "error_max_turns", is_error: true, result: undefined }));
    summary = foldMessage(summary, result({ result: "later text", num_turns: 3 }));
    assert.equal(summary.isError, true);
    assert.equal(summary.result, "Run ended: error_max_turns\n\nlater text");
    assert.equal(summary.turns, 3);
  });

  it("adds a stream failure to a result already received instead of replacing it", () => {
    const summary = foldFailure(foldMessage(EMPTY_SUMMARY, result({ result: "the answer" })), new Error("exit 1"));
    assert.equal(summary.isError, true);
    assert.equal(summary.result, "the answer\n\nThe run then failed: exit 1");
  });

  it("reports a failure before any result on its own", () => {
    const summary = foldFailure(EMPTY_SUMMARY, new Error("spawn ENOENT"));
    assert.equal(summary.result, "Run failed: spawn ENOENT");
    assert.equal(summary.isError, true);
  });
});

describe("run summary: later results", () => {
  it("keeps the cost when a later result omits it", () => {
    let summary = foldMessage(EMPTY_SUMMARY, result({ total_cost_usd: 0.5 }));
    summary = foldMessage(summary, result({ total_cost_usd: undefined }));
    assert.equal(summary.costUsd, 0.5);
  });

  it("keeps an earlier error's explanation when a later result succeeds", () => {
    let summary = foldMessage(EMPTY_SUMMARY, result({ subtype: "error_max_turns", is_error: true }));
    summary = foldMessage(summary, result({ result: "later text" }));
    assert.equal(summary.result, "Run ended: error_max_turns\n\nlater text");
  });
});
