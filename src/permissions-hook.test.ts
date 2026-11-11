import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  actorOf,
  createPermissionGate,
  createPolicy,
  createSafetyHooks,
} from "./permissions.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sdt-hook-")));
const project = join(root, "project");
mkdirSync(join(project, "src"), { recursive: true });
symlinkSync(join(project, "loopb"), join(project, "loopa"));
symlinkSync(join(project, "loopa"), join(project, "loopb"));

const SECRET = "sk-ant-test-0123456789abcdef";
const policy = createPolicy({
  cwd: project,
  agents: ["qa-tester"],
  pinnedModels: [],
  env: { ANTHROPIC_API_KEY: SECRET },
});

type Output = {
  continue?: boolean;
  hookSpecificOutput?: {
    permissionDecision?: string;
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
  };
};

function hookWith(onDeny?: (id: string, reason: string) => void) {
  const hook = createSafetyHooks(policy, onDeny).PreToolUse[0]!.hooks[0]!;
  return async (
    tool_name: string,
    tool_input: unknown,
    agent_id?: string,
  ): Promise<Output> =>
    (await hook(
      {
        hook_event_name: "PreToolUse",
        session_id: "s",
        transcript_path: "/t",
        cwd: project,
        tool_name,
        tool_use_id: "tu-1",
        tool_input,
        ...(agent_id ? { agent_id, agent_type: "qa-tester" } : {}),
      },
      "tu-1",
      { signal: new AbortController().signal },
    )) as Output;
}

const call = hookWith();
const reasonOf = (output: Output) =>
  output.hookSpecificOutput?.permissionDecision === "deny"
    ? (output.hookSpecificOutput.permissionDecisionReason ?? "")
    : null;

describe("C2: Bash always runs in the foreground", () => {
  it("rewrites an allowed Bash call with run_in_background: false", async () => {
    const output = await call("Bash", { command: "pnpm test" }, "a1");
    assert.deepEqual(output.hookSpecificOutput?.updatedInput, {
      command: "pnpm test",
      run_in_background: false,
    });
  });

  it("overrides an explicit background request", async () => {
    const output = await call(
      "Bash",
      { command: "pnpm dev", run_in_background: true },
      "a1",
    );
    assert.equal(
      output.hookSpecificOutput?.updatedInput?.run_in_background,
      false,
    );
    assert.equal(output.hookSpecificOutput?.permissionDecision, undefined);
  });

  it("still denies a Bash call the policy forbids", async () => {
    const output = await call(
      "Bash",
      { command: "rm -rf src", run_in_background: true },
      "a1",
    );
    assert.match(reasonOf(output) ?? "", /recursive delete/);
  });
});

describe("the hook fails closed", () => {
  it("denies a write through a symlink loop", async () => {
    const output = await call(
      "Write",
      { file_path: join(project, "loopa"), content: "x" },
      "a1",
    );
    assert.match(reasonOf(output) ?? "", /could not evaluate/);
  });

  it("denies when reading the tool input throws", async () => {
    const input = Object.defineProperty({}, "command", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    const output = await call("Bash", input, "a1");
    assert.match(reasonOf(output) ?? "", /blocked/);
  });

  it("still denies when onDeny throws", async () => {
    const throwing = hookWith(() => {
      throw new Error("ledger down");
    });
    const output = await throwing("Bash", { command: "rm -rf src" }, "a1");
    assert.match(reasonOf(output) ?? "", /ledger down|blocked/);
  });
});

describe("hook plumbing", () => {
  it("reports each deny to onDeny with the tool_use_id and reason", async () => {
    const denied: Array<[string, string]> = [];
    const hook = hookWith((id, reason) => denied.push([id, reason]));
    await hook("Bash", { command: "git reset --hard" }, "a1");
    assert.equal(denied.length, 1);
    assert.equal(denied[0]![0], "tu-1");
    assert.match(denied[0]![1], /discards uncommitted work/);
  });

  it("does not call onDeny for an allowed call", async () => {
    let calls = 0;
    await hookWith(() => (calls += 1))("Read", { file_path: "src/a.ts" });
    assert.equal(calls, 0);
  });

  it("passes other hook events through", async () => {
    const hook = createSafetyHooks(policy).PreToolUse[0]!.hooks[0]!;
    const output = await hook(
      {
        hook_event_name: "PostToolUse",
        session_id: "s",
        transcript_path: "/t",
        cwd: project,
        tool_name: "Bash",
        tool_use_id: "tu-1",
        tool_input: { command: "rm -rf /" },
        tool_response: "",
      },
      "tu-1",
      { signal: new AbortController().signal },
    );
    assert.deepEqual(output, { continue: true });
  });

  it("denies a manager delegation that carries a credential in its prompt", async () => {
    const output = await call("Agent", {
      subagent_type: "qa-tester",
      prompt: `log in with ${SECRET}`,
    });
    assert.match(reasonOf(output) ?? "", /value of a credential/);
  });
});

describe("actorOf", () => {
  it("is the manager when agent_id is absent", () => {
    assert.deepEqual(actorOf({}), { kind: "manager" });
  });

  it("is the manager on a --agent main thread that only sets agent_type", () => {
    assert.deepEqual(actorOf({ agent_type: "qa-tester" }), { kind: "manager" });
  });

  it("is the specialist when agent_id is present", () => {
    assert.deepEqual(actorOf({ agent_id: "a1", agent_type: "qa-tester" }), {
      kind: "agent",
      type: "qa-tester",
      id: "a1",
    });
  });

  it("the hook treats a --agent main thread as the manager", async () => {
    const hook = createSafetyHooks(policy).PreToolUse[0]!.hooks[0]!;
    const output = (await hook(
      {
        hook_event_name: "PreToolUse",
        session_id: "s",
        transcript_path: "/t",
        cwd: project,
        tool_name: "Bash",
        tool_use_id: "tu-1",
        tool_input: { command: "pnpm test" },
        agent_type: "qa-tester",
      },
      "tu-1",
      { signal: new AbortController().signal },
    )) as Output;
    assert.match(reasonOf(output) ?? "", /The manager reads and delegates/);
  });
});

describe("createPolicy", () => {
  it("returns a frozen policy", () => {
    assert.ok(Object.isFrozen(policy));
    assert.ok(Object.isFrozen(policy.secretValues));
  });
});

describe("createPermissionGate", () => {
  const options = {
    signal: new AbortController().signal,
    toolUseID: "tu-1",
    requestId: "r-1",
  };
  const gateAnswering = (answer: string | Error) => {
    const asked: string[] = [];
    const canUseTool = createPermissionGate(policy, async (question) => {
      asked.push(question);
      if (answer instanceof Error) throw answer;
      return answer;
    });
    const gate = async (
      tool: string,
      input: Record<string, unknown>,
      opts: typeof options,
    ) => {
      const result = await canUseTool(tool, input, opts);
      assert.ok(result, "the gate must always decide");
      return result;
    };
    return { gate, asked };
  };

  it("never prompts for a call the policy denies", async () => {
    const { gate, asked } = gateAnswering("y");
    const result = await gate("Bash", { command: "rm -rf src" }, options);
    assert.equal(result.behavior, "deny");
    assert.match((result as { message: string }).message, /recursive delete/);
    assert.equal(asked.length, 0);
  });

  it("denies a write through a symlink loop without prompting", async () => {
    const { gate, asked } = gateAnswering("y");
    const result = await gate(
      "Write",
      { file_path: join(project, "loopb"), content: "x" },
      options,
    );
    assert.equal(result.behavior, "deny");
    assert.match((result as { message: string }).message, /could not evaluate/);
    assert.equal(asked.length, 0);
  });

  for (const answer of ["y", "Y", " y "]) {
    it(`allows on ${JSON.stringify(answer)}`, async () => {
      const { gate } = gateAnswering(answer);
      const result = await gate("Bash", { command: "pnpm test" }, options);
      assert.equal(result.behavior, "allow");
    });
  }

  for (const answer of ["", "n", "yes", "yy", "N"]) {
    it(`denies on ${JSON.stringify(answer)}`, async () => {
      const { gate } = gateAnswering(answer);
      const result = await gate("Bash", { command: "pnpm test" }, options);
      assert.equal(result.behavior, "deny");
      assert.match((result as { message: string }).message, /declined/);
    });
  }

  it("denies when input closes before an answer", async () => {
    const { gate } = gateAnswering(new Error("input is closed"));
    const result = await gate("Bash", { command: "pnpm test" }, options);
    assert.equal(result.behavior, "deny");
    assert.match((result as { message: string }).message, /input closed/);
  });

  it("strips control characters before prompting", async () => {
    const { gate, asked } = gateAnswering("n");
    await gate("Bash", { command: "ls\x1b[2K\r\x07pnpm test" }, options);
    assert.equal(asked.length, 1);
    assert.doesNotMatch(asked[0]!.split("\n")[1]!, /[\x00-\x1f\x7f]/);
    assert.match(asked[0]!, /ls \[2K pnpm test/);
  });
});
