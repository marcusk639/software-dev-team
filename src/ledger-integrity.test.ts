import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HookInput, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createLedger, ledgerConcerns } from "./ledger.js";

const CWD = "/work/project";
const signal = new AbortController().signal;
const AGENT = "a1b2c3d4e5f6";

function base(id: string, tool: string, input: unknown, agent?: string) {
  return {
    session_id: "s",
    transcript_path: "/t",
    cwd: CWD,
    tool_name: tool,
    tool_input: input,
    tool_use_id: id,
    ...(agent ? { agent_type: agent, agent_id: AGENT } : {}),
  };
}

type Ledger = ReturnType<typeof createLedger>;

async function fire(ledger: Ledger, input: HookInput) {
  const matchers =
    ledger.hooks[
      input.hook_event_name as
        "PreToolUse" | "PostToolUse" | "PostToolUseFailure"
    ] ?? [];
  let last: unknown;
  for (const m of matchers)
    for (const h of m.hooks) last = await h(input, undefined, { signal });
  return last;
}

async function run(
  ledger: Ledger,
  id: string,
  command: string,
  end: "ok" | "failed" = "ok",
) {
  await fire(ledger, {
    ...base(id, "Bash", { command }, "qa-tester"),
    hook_event_name: "PreToolUse",
  });
  await fire(
    ledger,
    end === "ok"
      ? {
          ...base(id, "Bash", { command }, "qa-tester"),
          hook_event_name: "PostToolUse",
          tool_response: { stdout: "", stderr: "", interrupted: false },
        }
      : {
          ...base(id, "Bash", { command }, "qa-tester"),
          hook_event_name: "PostToolUseFailure",
          error: "Exit code 1",
        },
  );
}

async function evidence(ledger: Ledger, response: unknown): Promise<string> {
  const output = await fire(ledger, {
    ...base("delegation", "Agent", { subagent_type: "qa-tester" }),
    hook_event_name: "PostToolUse",
    tool_response: response,
  });
  return (output as { hookSpecificOutput: { additionalContext: string } })
    .hookSpecificOutput.additionalContext;
}

describe("ledger: background calls (C2)", () => {
  it("records a Bash call that returned a background task id as started, not ok", async () => {
    const ledger = createLedger({ cwd: CWD, secretValues: [] });
    await fire(ledger, {
      ...base("1", "Bash", { command: "pnpm test" }, "qa-tester"),
      hook_event_name: "PreToolUse",
    });
    await fire(ledger, {
      ...base("1", "Bash", { command: "pnpm test" }, "qa-tester"),
      hook_event_name: "PostToolUse",
      tool_response: {
        stdout: "",
        stderr: "",
        interrupted: false,
        backgroundTaskId: "bg-1",
      },
    });
    const [entry] = ledger.entries();
    assert.equal(entry?.outcome, "started");
    assert.match(entry?.note ?? "", /background/);
    assert.match(ledger.format(), /started: .*background/);
  });

  it("records a Bash call whose input still asked for the background as started", async () => {
    const ledger = createLedger({ cwd: CWD, secretValues: [] });
    const input = { command: "pnpm dev", run_in_background: true };
    await fire(ledger, {
      ...base("1", "Bash", input, "qa-tester"),
      hook_event_name: "PreToolUse",
    });
    await fire(ledger, {
      ...base("1", "Bash", input, "qa-tester"),
      hook_event_name: "PostToolUse",
      tool_response: { stdout: "", stderr: "", interrupted: false },
    });
    assert.equal(ledger.entries()[0]?.outcome, "started");
  });

  it("records a delegation that launched asynchronously as started", async () => {
    const ledger = createLedger({ cwd: CWD, secretValues: [] });
    await fire(ledger, {
      ...base("1", "Agent", { subagent_type: "qa-tester" }),
      hook_event_name: "PreToolUse",
    });
    await fire(ledger, {
      ...base("1", "Agent", { subagent_type: "qa-tester" }),
      hook_event_name: "PostToolUse",
      tool_response: { status: "async_launched", agentId: "x1" },
    });
    assert.equal(ledger.entries()[0]?.outcome, "started");
  });

  it("still records an ordinary foreground Bash call as ok", async () => {
    const ledger = createLedger({ cwd: CWD, secretValues: [] });
    await run(ledger, "1", "pnpm test");
    assert.equal(ledger.entries()[0]?.outcome, "ok");
  });
});

describe("ledger: delegation evidence integrity (I9)", () => {
  it("(a) keeps every failed row and the most recent rows when there are too many", async () => {
    const ledger = createLedger({ cwd: CWD, secretValues: [] });
    await run(ledger, "f", "pnpm test first-failure", "failed");
    for (let i = 0; i < 40; i += 1) await run(ledger, `ok${i}`, `step ${i}`);
    await run(ledger, "f2", "pnpm test late-failure", "failed");
    const text = await evidence(ledger, {
      status: "completed",
      agentId: AGENT,
    });
    assert.match(text, /first-failure: failed/);
    assert.match(text, /late-failure: failed/);
    assert.match(text, /step 39: ok/);
    assert.doesNotMatch(text, /step 0: ok/);
    assert.match(text, /and \d+ more/);
    const listed = text.split("\n").filter((l) => l.startsWith("- Bash"));
    assert.equal(listed.length, 30);
    // Chronological order is kept.
    assert.ok(text.indexOf("first-failure") < text.indexOf("step 39"));
  });

  it("(a) lists blocked, refused, started and unsettled rows even past the cap", async () => {
    const ledger = createLedger({ cwd: CWD, secretValues: [] });
    for (let i = 0; i < 35; i += 1) await run(ledger, `ok${i}`, `step ${i}`);
    await fire(ledger, {
      ...base("b", "Bash", { command: "rm -rf x" }, "qa-tester"),
      hook_event_name: "PreToolUse",
    });
    ledger.block("b", "Blocked by the team's safety policy.");
    await fire(ledger, {
      ...base("u", "Bash", { command: "pnpm e2e" }, "qa-tester"),
      hook_event_name: "PreToolUse",
    });
    const text = await evidence(ledger, {
      status: "completed",
      agentId: AGENT,
    });
    assert.match(text, /rm -rf x: blocked/);
    assert.match(text, /pnpm e2e: no result recorded/);
  });

  it("(b) says the record is unavailable when a delegation returns no agent id", async () => {
    const ledger = createLedger({ cwd: CWD, secretValues: [] });
    for (const response of [{ status: "completed" }, null, "text"]) {
      const text = await evidence(ledger, response);
      assert.match(
        text,
        /Harness record unavailable for this delegation; treat the report as unverified/,
      );
    }
  });

  it("(c) records a call it never saw start, flagged as such, instead of dropping it", async () => {
    const ledger = createLedger({ cwd: CWD, secretValues: [] });
    await fire(ledger, {
      ...base("x", "Bash", { command: "pnpm build" }, "qa-tester"),
      hook_event_name: "PostToolUse",
      tool_response: {},
    });
    await fire(ledger, {
      ...base("y", "Write", { file_path: `${CWD}/a.ts` }, "qa-tester"),
      hook_event_name: "PostToolUseFailure",
      error: "EACCES",
    });
    ledger.observe({
      type: "system",
      subtype: "permission_denied",
      tool_name: "Bash",
      tool_use_id: "z",
      decision_reason: "no approval",
    } as unknown as SDKMessage);
    const rows = ledger.entries();
    assert.deepEqual(
      rows.map((e) => [e.toolUseId, e.tool, e.detail, e.outcome]),
      [
        ["x", "Bash", "pnpm build", "ok"],
        ["y", "Write", "a.ts", "failed"],
        ["z", "Bash", "", "refused"],
      ],
    );
    assert.ok(rows.every((e) => e.noPreToolUseRecord === true));
    assert.equal(rows[0]?.role, "qa-tester");
    assert.match(ledger.format(), /no PreToolUse record/);
  });

  it("(d) survives a failure with no error text", async () => {
    const ledger = createLedger({ cwd: CWD, secretValues: [] });
    await fire(ledger, {
      ...base("1", "Bash", { command: "x" }, "qa-tester"),
      hook_event_name: "PreToolUse",
    });
    await fire(ledger, {
      ...base("1", "Bash", { command: "x" }, "qa-tester"),
      hook_event_name: "PostToolUseFailure",
    } as unknown as HookInput);
    assert.equal(ledger.entries()[0]?.outcome, "failed");
    assert.equal(ledger.entries()[0]?.note, "unknown error");
  });

  it("(e) counts the entries an operator should look at", async () => {
    const ledger = createLedger({ cwd: CWD, secretValues: [] });
    await run(ledger, "1", "pnpm test");
    await run(ledger, "2", "pnpm lint", "failed");
    await fire(ledger, {
      ...base("3", "Bash", { command: "pnpm e2e" }, "qa-tester"),
      hook_event_name: "PreToolUse",
    });
    ledger.block("4", "nope");
    await fire(ledger, {
      ...base("4", "Bash", { command: "rm -rf /" }, "qa-tester"),
      hook_event_name: "PreToolUse",
    });
    const concerns = ledgerConcerns(ledger.entries());
    assert.deepEqual(concerns.counts, {
      failed: 1,
      blocked: 1,
      refused: 0,
      started: 0,
      unfinished: 1,
    });
    assert.match(
      concerns.warning ?? "",
      /1 failed, 1 blocked, 1 with no result/,
    );
    assert.equal(ledgerConcerns([]).warning, undefined);
  });
});

describe("ledger: entries are read-only snapshots", () => {
  it("returns frozen copies carrying the tool use id", async () => {
    const ledger = createLedger({ cwd: CWD, secretValues: [] });
    await fire(ledger, {
      ...base("1", "Bash", { command: "pnpm test" }, "qa-tester"),
      hook_event_name: "PreToolUse",
    });
    const [entry] = ledger.entries();
    assert.equal(entry?.toolUseId, "1");
    assert.ok(Object.isFrozen(entry));
    assert.throws(() => {
      (entry as { outcome: string }).outcome = "ok";
    }, TypeError);
    assert.equal(ledger.entries()[0]?.outcome, "unfinished");
    // A snapshot does not change when the call later settles.
    await fire(ledger, {
      ...base("1", "Bash", { command: "pnpm test" }, "qa-tester"),
      hook_event_name: "PostToolUse",
      tool_response: {},
    });
    assert.equal(entry?.outcome, "unfinished");
    assert.equal(ledger.entries()[0]?.outcome, "ok");
  });
});
