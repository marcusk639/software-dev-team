import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { HookInput, Options } from "@anthropic-ai/claude-agent-sdk";
import { ROLES } from "../team.js";
import { prepareRun } from "./index.js";

const signal = new AbortController().signal;

function target() {
  const cwd = mkdtempSync(join(tmpdir(), "sdt-wiring-"));
  const dir = join(cwd, ".claude", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "helper.md"),
    "---\nname: helper\ndescription: d\nmodel: sonnet\n---\nbody\n",
  );
  writeFileSync(
    join(dir, "loose.md"),
    "---\nname: loose\ndescription: d\n---\nbody\n",
  );
  writeFileSync(
    join(dir, "gp.md"),
    "---\nname: general-purpose\ndescription: d\n---\n",
  );
  writeFileSync(
    join(dir, "qa.md"),
    "---\nname: qa-tester\nmodel: haiku\n---\n",
  );
  return cwd;
}

/** Runs every PreToolUse hook the run installs and returns the first deny reason. */
async function preToolUse(
  options: Options,
  tool: string,
  toolInput: Record<string, unknown>,
  agent?: string,
): Promise<string | undefined> {
  const input = {
    hook_event_name: "PreToolUse",
    session_id: "s",
    transcript_path: "/t",
    cwd: options.cwd ?? "/",
    tool_name: tool,
    tool_input: toolInput,
    tool_use_id: `t-${Math.random()}`,
    ...(agent ? { agent_type: agent, agent_id: "agent-1" } : {}),
  } as HookInput;
  for (const matcher of options.hooks?.PreToolUse ?? []) {
    for (const hook of matcher.hooks) {
      const out = (await hook(input, "t", {
        signal,
      })) as {
        hookSpecificOutput?: {
          permissionDecision?: string;
          permissionDecisionReason?: string;
        };
      };
      if (out.hookSpecificOutput?.permissionDecision === "deny") {
        return out.hookSpecificOutput.permissionDecisionReason;
      }
    }
  }
  return undefined;
}

describe("runTeam wiring", () => {
  const cwd = target();

  it("runs unattended under --yes: acceptEdits and no approval gate", () => {
    const { queryOptions } = prepareRun({ task: "t", cwd, autoApprove: true });
    assert.equal(queryOptions.permissionMode, "acceptEdits");
    assert.equal(queryOptions.canUseTool, undefined);
    assert.equal("canUseTool" in queryOptions, false);
  });

  it("asks a human without --yes", () => {
    const { queryOptions } = prepareRun({ task: "t", cwd, autoApprove: false });
    assert.equal(queryOptions.permissionMode, "default");
    assert.equal(typeof queryOptions.canUseTool, "function");
  });

  it("takes the built-in agents off the menu and loads the target's settings", () => {
    const { queryOptions } = prepareRun({ task: "t", cwd, autoApprove: true });
    assert.equal(
      queryOptions.env?.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS,
      "1",
    );
    assert.deepEqual(queryOptions.settingSources, ["project"]);
    assert.deepEqual(Object.keys(queryOptions.agents ?? {}), ROLES);
    assert.ok(queryOptions.allowedTools?.includes("Grep"));
    assert.ok((queryOptions.maxTurns ?? 0) > 0);
  });

  it("installs the safety hook, which blocks destructive commands from specialists", async () => {
    const { queryOptions } = prepareRun({ task: "t", cwd, autoApprove: true });
    const reason = await preToolUse(
      queryOptions,
      "Bash",
      { command: "rm -rf /" },
      "qa-tester",
    );
    assert.match(reason ?? "", /safety policy|delete/i);
    assert.equal(
      await preToolUse(
        queryOptions,
        "Bash",
        { command: "pnpm test" },
        "qa-tester",
      ),
      undefined,
    );
  });

  it("keeps the manager to reading and delegating", async () => {
    const { queryOptions } = prepareRun({ task: "t", cwd, autoApprove: true });
    assert.match(
      (await preToolUse(queryOptions, "Bash", { command: "ls" })) ?? "",
      /manager reads and delegates/,
    );
  });

  it("pins the models of team roles and of project agents that declare one", async () => {
    const { queryOptions } = prepareRun({ task: "t", cwd, autoApprove: true });
    const delegate = (subagent_type: string, model?: string) =>
      preToolUse(queryOptions, "Agent", {
        subagent_type,
        prompt: "p",
        ...(model ? { model } : {}),
      });
    assert.match(
      (await delegate("architect", "haiku")) ?? "",
      /model its definition sets/,
    );
    assert.match(
      (await delegate("qa-tester", "haiku")) ?? "",
      /model its definition sets/,
    );
    assert.match(
      (await delegate("helper", "haiku")) ?? "",
      /model its definition sets/,
    );
    assert.equal(await delegate("helper"), undefined);
    assert.equal(await delegate("loose", "haiku"), undefined);
  });

  it("rejects project agents that shadow built-ins or team roles, with warnings", async () => {
    const { queryOptions, warnings } = prepareRun({
      task: "t",
      cwd,
      autoApprove: true,
    });
    assert.match(
      (await preToolUse(queryOptions, "Agent", {
        subagent_type: "general-purpose",
        prompt: "p",
      })) ?? "",
      /not on this team/,
    );
    assert.ok(warnings.some((w) => /general-purpose.*built-in/.test(w)));
    assert.ok(warnings.some((w) => /qa-tester.*team role/.test(w)));
  });

  it("denies reads outside --cwd under --yes and leaves them to the human otherwise", async () => {
    const read = { file_path: "/etc/hosts" };
    const unattended = prepareRun({ task: "t", cwd, autoApprove: true });
    assert.match(
      (await preToolUse(unattended.queryOptions, "Read", read, "qa-tester")) ?? "",
      /outside the project/,
    );
    const interactive = prepareRun({ task: "t", cwd, autoApprove: false });
    assert.equal(
      await preToolUse(interactive.queryOptions, "Read", read, "qa-tester"),
      undefined,
    );
  });

  it("lets an allow rule open a directory outside --cwd to reads", async () => {
    const { queryOptions } = prepareRun({
      task: "t",
      cwd,
      autoApprove: true,
      allow: [`Read(/${tmpdir()}/**)`],
    });
    assert.equal(
      await preToolUse(queryOptions, "Read", { file_path: join(tmpdir(), "notes.txt") }, "qa-tester"),
      undefined,
    );
  });
});
