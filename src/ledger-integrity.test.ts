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

/** A Bash call from a given agent, started and settled through the real hooks. */
async function call(
  ledger: Ledger,
  id: string,
  command: string,
  agentId: string,
  end: "ok" | "failed" | "pending" | "interrupted",
  tool = "Bash",
) {
  const who = { agent_type: "qa-tester", agent_id: agentId };
  const input = tool === "Bash" ? { command } : { file_path: command };
  await fire(ledger, { ...base(id, tool, input), ...who, hook_event_name: "PreToolUse" });
  if (end !== "pending") await settleCall(ledger, id, command, agentId, end, tool);
}

async function settleCall(
  ledger: Ledger,
  id: string,
  command: string,
  agentId: string,
  end: "ok" | "failed" | "interrupted",
  tool = "Bash",
) {
  const who = { agent_type: "qa-tester", agent_id: agentId };
  const input = tool === "Bash" ? { command } : { file_path: command };
  await fire(
    ledger,
    end === "failed"
      ? { ...base(id, tool, input), ...who, hook_event_name: "PostToolUseFailure", error: "Exit code 1" }
      : {
          ...base(id, tool, input),
          ...who,
          hook_event_name: "PostToolUse",
          tool_response: { stdout: "", stderr: "", interrupted: end === "interrupted" },
        },
  );
}

describe("I6: a failure is superseded only by a later passing run of the same Bash command", () => {
  it("does not let another agent's pass supersede a failure", async () => {
    const ledger = createLedger({ cwd: CWD, secretValues: [] });
    await call(ledger, "1", "pnpm test", "a1", "failed");
    await call(ledger, "2", "pnpm test", "b2", "ok");
    const c = ledgerConcerns(ledger.entries());
    assert.equal(c.laterPassed, 0);
    assert.equal(c.counts.failed, 1);
  });

  it("keeps a failure when the same command only started again", async () => {
    const ledger = createLedger({ cwd: CWD, secretValues: [] });
    await call(ledger, "1", "pnpm test", "a1", "failed");
    await call(ledger, "2", "pnpm test", "a1", "pending");
    const c = ledgerConcerns(ledger.entries());
    assert.equal(c.laterPassed, 0);
    assert.equal(c.counts.failed, 1);
  });

  it("supersedes only the command that later passed when failures interleave", async () => {
    const ledger = createLedger({ cwd: CWD, secretValues: [] });
    await call(ledger, "1", "pnpm test", "a1", "failed");
    await call(ledger, "2", "pnpm lint", "a1", "failed");
    await call(ledger, "3", "pnpm test", "a1", "ok");
    const c = ledgerConcerns(ledger.entries());
    assert.equal(c.laterPassed, 1);
    assert.equal(c.counts.failed, 1);
  });

  it("orders by when calls settled, not when they started", async () => {
    // The failure started first but finished after the pass.
    const ledger = createLedger({ cwd: CWD, secretValues: [] });
    await call(ledger, "1", "pnpm test", "a1", "pending");
    await call(ledger, "2", "pnpm test", "a1", "pending");
    await settleCall(ledger, "2", "pnpm test", "a1", "ok");
    await settleCall(ledger, "1", "pnpm test", "a1", "failed");
    const c = ledgerConcerns(ledger.entries());
    assert.equal(c.laterPassed, 0);
    assert.equal(c.counts.failed, 1);
  });

  it("does not let another tool with the same detail supersede a failure", async () => {
    const ledger = createLedger({ cwd: CWD, secretValues: [] });
    await call(ledger, "1", "src/a.ts", "a1", "failed", "Edit");
    await call(ledger, "2", "src/a.ts", "a1", "ok", "Edit");
    await call(ledger, "3", "x", "a1", "failed");
    await call(ledger, "4", "x", "a1", "ok", "Write");
    const c = ledgerConcerns(ledger.entries());
    assert.equal(c.laterPassed, 0);
    assert.equal(c.counts.failed, 2);
  });
});

describe("I7: evidence gaps are recorded, not hidden", () => {
  it("records an interrupted Bash call as failed, and it cannot supersede", async () => {
    const ledger = createLedger({ cwd: CWD, secretValues: [] });
    await call(ledger, "1", "pnpm test", "a1", "failed");
    await call(ledger, "2", "pnpm test", "a1", "interrupted");
    const [, interrupted] = ledger.entries();
    assert.equal(interrupted?.outcome, "failed");
    assert.match(interrupted?.note ?? "", /interrupted/);
    const c = ledgerConcerns(ledger.entries());
    assert.equal(c.laterPassed, 0);
    assert.equal(c.counts.failed, 2);
  });

  it("counts a hook or stream fault instead of only logging it", async () => {
    const ledger = createLedger({ cwd: CWD, secretValues: [] });
    assert.equal(ledger.faults(), 0);
    // A hook input the ledger cannot read: no tool_use_id.
    await fire(ledger, { hook_event_name: "PostToolUse" } as unknown as HookInput);
    ledger.observe(null as unknown as SDKMessage);
    assert.equal(ledger.faults(), 2);
  });

  it("puts duration only on settled ok and failed entries", async () => {
    const ledger = createLedger({ cwd: CWD, secretValues: [] });
    await call(ledger, "1", "pnpm test", "a1", "pending");
    const [started] = ledger.entries();
    assert.equal("durationMs" in (started ?? {}), false);
  });
});
