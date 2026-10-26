import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HookInput, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createLedger } from "./ledger.js";

const CWD = "/work/project";
const signal = new AbortController().signal;

function base(id: string, tool: string, input: unknown, agent?: string) {
  return {
    session_id: "s",
    transcript_path: "/t",
    cwd: CWD,
    tool_name: tool,
    tool_input: input,
    tool_use_id: id,
    ...(agent ? { agent_type: agent, agent_id: "a1b2c3d4e5f6" } : {}),
  };
}

async function fire(ledger: ReturnType<typeof createLedger>, input: HookInput) {
  const matchers =
    ledger.hooks[
      input.hook_event_name as
        "PreToolUse" | "PostToolUse" | "PostToolUseFailure"
    ] ?? [];
  for (const m of matchers)
    for (const h of m.hooks) await h(input, undefined, { signal });
}

describe("ledger", () => {
  it("records what ran, what failed, what was blocked and what was refused", async () => {
    const ledger = createLedger({
      cwd: CWD,
      secretValues: ["sk-secret-value-123"],
    });

    await fire(ledger, {
      ...base("1", "Bash", { command: "pnpm test" }, "qa-tester"),
      hook_event_name: "PreToolUse",
    });
    await fire(ledger, {
      ...base("1", "Bash", { command: "pnpm test" }, "qa-tester"),
      hook_event_name: "PostToolUse",
      tool_response: {},
      duration_ms: 1800,
    });

    await fire(ledger, {
      ...base("2", "Bash", { command: "false" }, "qa-tester"),
      hook_event_name: "PreToolUse",
    });
    await fire(ledger, {
      ...base("2", "Bash", { command: "false" }, "qa-tester"),
      hook_event_name: "PostToolUseFailure",
      error: "Exit code 1\nboom",
    });

    await fire(ledger, {
      ...base(
        "3",
        "Write",
        { file_path: `${CWD}/src/a.ts` },
        "backend-engineer",
      ),
      hook_event_name: "PreToolUse",
    });
    await fire(ledger, {
      ...base(
        "3",
        "Write",
        { file_path: `${CWD}/src/a.ts` },
        "backend-engineer",
      ),
      hook_event_name: "PostToolUse",
      tool_response: {},
    });

    await fire(ledger, {
      ...base("4", "Bash", { command: "rm -rf /" }, "qa-tester"),
      hook_event_name: "PreToolUse",
    });
    ledger.block(
      "4",
      "Blocked by the team's safety policy (recursive or forced delete).",
    );

    await fire(ledger, {
      ...base("5", "Bash", { command: "printenv HOME" }, "qa-tester"),
      hook_event_name: "PreToolUse",
    });
    ledger.observe({
      type: "system",
      subtype: "permission_denied",
      tool_name: "Bash",
      tool_use_id: "5",
      decision_reason: "no approval surface",
    } as unknown as SDKMessage);

    await fire(ledger, {
      ...base("6", "Agent", { subagent_type: "qa-tester", prompt: "p" }),
      hook_event_name: "PreToolUse",
    });
    await fire(ledger, {
      ...base("6", "Agent", { subagent_type: "qa-tester", prompt: "p" }),
      hook_event_name: "PostToolUse",
      tool_response: {},
    });

    await fire(ledger, {
      ...base("7", "Read", { file_path: `${CWD}/README.md` }, "architect"),
      hook_event_name: "PreToolUse",
    });
    await fire(ledger, {
      ...base("7", "Read", { file_path: `${CWD}/README.md` }, "architect"),
      hook_event_name: "PostToolUse",
      tool_response: {},
    });

    await fire(ledger, {
      ...base(
        "8",
        "Bash",
        { command: "echo sk-secret-value-123" },
        "qa-tester",
      ),
      hook_event_name: "PreToolUse",
    });

    ledger.observe({
      type: "result",
      permission_denials: [
        { tool_name: "Bash", tool_use_id: "8", tool_input: {} },
      ],
    } as unknown as SDKMessage);

    const rows = ledger
      .entries()
      .map((e) => [e.role, e.tool, e.detail, e.outcome]);
    assert.deepEqual(rows, [
      ["qa-tester", "Bash", "pnpm test", "ok"],
      ["qa-tester", "Bash", "false", "failed"],
      ["backend-engineer", "Write", "src/a.ts", "ok"],
      ["qa-tester", "Bash", "rm -rf /", "blocked"],
      ["qa-tester", "Bash", "printenv HOME", "refused"],
      ["manager", "Agent", "→ qa-tester", "ok"],
      ["qa-tester", "Bash", "echo [redacted]", "refused"],
    ]);
    assert.equal(ledger.entries()[1]!.note, "Exit code 1");

    const text = ledger.format();
    assert.match(text, /qa-tester#a1b2c3\s+Bash\s+pnpm test\s+ok 1\.8s/);
    assert.match(text, /failed: Exit code 1/);
    assert.doesNotMatch(text, /sk-secret-value-123/);
  });

  it("marks calls that never finished", async () => {
    const ledger = createLedger({ cwd: CWD, secretValues: [] });
    await fire(ledger, {
      ...base("1", "Bash", { command: "sleep 100" }, "qa-tester"),
      hook_event_name: "PreToolUse",
    });
    assert.equal(ledger.entries()[0]!.outcome, "unfinished");
  });

  it("formats an empty ledger as nothing", () => {
    assert.equal(createLedger({ cwd: CWD, secretValues: [] }).format(), "");
  });
});

describe("ledger ordering", () => {
  it("keeps a block that arrives before the call is recorded", async () => {
    const ledger = createLedger({ cwd: CWD, secretValues: [] });
    ledger.block("9", "denied");
    await fire(ledger, {
      ...base("9", "Bash", { command: "rm -rf x" }, "qa-tester"),
      hook_event_name: "PreToolUse",
    });
    assert.deepEqual(
      ledger.entries().map((e) => [e.outcome, e.note]),
      [["blocked", "denied"]],
    );
  });
});

describe("ledger redaction", () => {
  it("redacts credentials in failure notes", async () => {
    const ledger = createLedger({
      cwd: CWD,
      secretValues: ["sk-secret-value-123"],
    });
    await fire(ledger, {
      ...base("1", "Bash", { command: "pnpm test" }, "qa-tester"),
      hook_event_name: "PreToolUse",
    });
    await fire(ledger, {
      ...base("1", "Bash", { command: "pnpm test" }, "qa-tester"),
      hook_event_name: "PostToolUseFailure",
      error: "bad key sk-secret-value-123",
    });
    assert.equal(ledger.entries()[0]!.note, "bad key [redacted]");
  });
});

describe("ledger output hygiene", () => {
  it("keeps notes on one line and strips control characters", async () => {
    const ledger = createLedger({ cwd: CWD, secretValues: [] });
    await fire(ledger, {
      ...base("1", "Bash", { command: "echo \u001b[31mred" }, "qa-tester"),
      hook_event_name: "PreToolUse",
    });
    ledger.block("1", "first line\nsecond\tline");
    const [entry] = ledger.entries();
    assert.equal(entry!.note, "first line second line");
    assert.equal(entry!.detail, "echo [31mred");
  });
});

describe("delegation evidence for the manager", () => {
  it("tells the manager what the returning specialist actually ran", async () => {
    const ledger = createLedger({ cwd: CWD, secretValues: [] });
    await fire(ledger, {
      ...base("1", "Bash", { command: "pnpm test" }, "qa-tester"),
      hook_event_name: "PreToolUse",
    });
    await fire(ledger, {
      ...base("1", "Bash", { command: "pnpm test" }, "qa-tester"),
      hook_event_name: "PostToolUseFailure",
      error: "Exit code 1",
    });
    await fire(ledger, {
      ...base(
        "2",
        "Write",
        { file_path: `${CWD}/test/a.test.ts` },
        "qa-tester",
      ),
      hook_event_name: "PreToolUse",
    });
    await fire(ledger, {
      ...base(
        "2",
        "Write",
        { file_path: `${CWD}/test/a.test.ts` },
        "qa-tester",
      ),
      hook_event_name: "PostToolUse",
      tool_response: {},
    });
    await fire(ledger, {
      ...base("3", "Bash", { command: "ls" }, "architect"),
      agent_id: "arch-99",
      hook_event_name: "PreToolUse",
    });
    ledger.block("3", "nope");

    const [matcher] = ledger.hooks.PostToolUse;
    const output = await matcher!.hooks[0]!(
      {
        ...base("9", "Agent", { subagent_type: "qa-tester" }),
        hook_event_name: "PostToolUse",
        tool_response: { status: "completed", agentId: "a1b2c3d4e5f6" },
      },
      "9",
      { signal },
    );
    const context = (
      output as { hookSpecificOutput: { additionalContext: string } }
    ).hookSpecificOutput.additionalContext;
    assert.match(context, /recorded by the harness/);
    assert.match(context, /Bash pnpm test: failed \(Exit code 1\)/);
    assert.match(context, /Write test\/a\.test\.ts: ok/);
    assert.doesNotMatch(context, /architect|nope/);
  });

  it("says so when the specialist ran nothing", async () => {
    const ledger = createLedger({ cwd: CWD, secretValues: [] });
    const [matcher] = ledger.hooks.PostToolUse;
    const output = await matcher!.hooks[0]!(
      {
        ...base("9", "Agent", { subagent_type: "architect" }),
        hook_event_name: "PostToolUse",
        tool_response: { status: "completed", agentId: "zzz" },
      },
      "9",
      { signal },
    );
    assert.match(
      (output as { hookSpecificOutput: { additionalContext: string } })
        .hookSpecificOutput.additionalContext,
      /no recorded commands or file changes/,
    );
  });
});

describe("delegation evidence wording", () => {
  async function evidence(ledger: ReturnType<typeof createLedger>, agentId: string) {
    const output = await ledger.hooks.PostToolUse[0]!.hooks[0]!(
      { ...base("99", "Agent", { subagent_type: "x" }), hook_event_name: "PostToolUse", tool_response: { status: "completed", agentId } },
      "99",
      { signal },
    );
    return (output as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
  }

  it("records writes made through tools other than Write and Edit", async () => {
    const ledger = createLedger({ cwd: CWD, secretValues: [] });
    await fire(ledger, { ...base("1", "MultiEdit", { file_path: `${CWD}/src/a.ts` }, "backend-engineer"), hook_event_name: "PreToolUse" });
    await fire(ledger, { ...base("1", "MultiEdit", { file_path: `${CWD}/src/a.ts` }, "backend-engineer"), hook_event_name: "PostToolUse", tool_response: {} });
    await fire(ledger, { ...base("2", "mcp__db__query", { sql: "x" }, "backend-engineer"), hook_event_name: "PreToolUse" });
    await fire(ledger, { ...base("3", "Read", { file_path: `${CWD}/src/a.ts` }, "backend-engineer"), hook_event_name: "PreToolUse" });
    const text = await evidence(ledger, "a1b2c3d4e5f6");
    assert.match(text, /MultiEdit src\/a\.ts: ok/);
    assert.match(text, /mcp__db__query/);
    assert.doesNotMatch(text, /- Read/);
  });

  it("does not claim nothing was changed, only that nothing was recorded", async () => {
    const text = await evidence(createLedger({ cwd: CWD, secretValues: [] }), "none");
    assert.match(text, /no recorded commands or file changes \(reads are not recorded\)/);
  });

  it("says a call with no result was refused or not run, and flags nested delegations", async () => {
    const ledger = createLedger({ cwd: CWD, secretValues: [] });
    await fire(ledger, { ...base("1", "Bash", { command: "pnpm test" }, "qa-tester"), hook_event_name: "PreToolUse" });
    await fire(ledger, { ...base("2", "Agent", { subagent_type: "helper" }, "qa-tester"), hook_event_name: "PreToolUse" });
    await fire(ledger, { ...base("2", "Agent", { subagent_type: "helper" }, "qa-tester"), hook_event_name: "PostToolUse", tool_response: {} });
    const text = await evidence(ledger, "a1b2c3d4e5f6");
    assert.match(text, /Bash pnpm test: no result recorded \(refused or not run\)/);
    assert.match(text, /Agent → helper: ok \(nested delegation; its own calls are not listed here\)/);
  });
});

describe("ledger integrity", () => {
  it("hands out copies, so a caller cannot rewrite the evidence", async () => {
    const ledger = createLedger({ cwd: CWD, secretValues: [] });
    await fire(ledger, { ...base("1", "Bash", { command: "pnpm test" }, "qa-tester"), hook_event_name: "PreToolUse" });
    await fire(ledger, { ...base("1", "Bash", { command: "pnpm test" }, "qa-tester"), hook_event_name: "PostToolUseFailure", error: "Exit code 1" });
    const [entry] = ledger.entries();
    assert.throws(() => {
      (entry as { outcome: string }).outcome = "ok";
    });
    assert.equal(ledger.entries()[0]!.outcome, "failed");
  });

  it("keeps a hook's block when the call is later also listed as refused", async () => {
    const ledger = createLedger({ cwd: CWD, secretValues: [] });
    await fire(ledger, { ...base("4", "Bash", { command: "rm -rf x" }, "qa-tester"), hook_event_name: "PreToolUse" });
    ledger.block("4", "recursive delete");
    ledger.observe({ type: "result", permission_denials: [{ tool_name: "Bash", tool_use_id: "4", tool_input: {} }] } as unknown as SDKMessage);
    assert.deepEqual(ledger.entries().map((e) => [e.outcome, e.note]), [["blocked", "recursive delete"]]);
  });

  it("tolerates a result without permission_denials", () => {
    const ledger = createLedger({ cwd: CWD, secretValues: [] });
    assert.doesNotThrow(() => ledger.observe({ type: "result" } as unknown as SDKMessage));
  });
});
