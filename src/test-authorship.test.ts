import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { createTestAuthorship } from "./test-authorship.js";

const signal = new AbortController().signal;

function project() {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "sdt-authorship-")));
  mkdirSync(join(cwd, "src/__tests__"), { recursive: true });
  writeFileSync(join(cwd, "src/a.ts"), "export {};\n");
  return cwd;
}

type Event = "PreToolUse" | "PostToolUse";

async function fire(
  authorship: ReturnType<typeof createTestAuthorship>,
  event: Event,
  agent: string | undefined,
  tool: string,
  input: Record<string, unknown>,
) {
  const id = `t-${Math.random()}`;
  const hookInput = {
    hook_event_name: event,
    session_id: "s",
    transcript_path: "/t",
    cwd: "/",
    tool_name: tool,
    tool_input: input,
    tool_use_id: id,
    ...(event === "PostToolUse" ? { tool_response: { ok: true } } : {}),
    ...(agent ? { agent_type: agent, agent_id: `${agent}-1` } : {}),
  } as HookInput;
  const outputs = [];
  for (const matcher of authorship.hooks[event]) {
    for (const hook of matcher.hooks)
      outputs.push(await hook(hookInput, id, { signal }));
  }
  const denied = outputs.find(
    (o) =>
      (o as { hookSpecificOutput?: { permissionDecision?: string } })
        .hookSpecificOutput?.permissionDecision === "deny",
  ) as { hookSpecificOutput: { permissionDecisionReason: string } } | undefined;
  return denied?.hookSpecificOutput.permissionDecisionReason;
}

describe("acceptance tests belong to the role that wrote them", () => {
  it("denies an engineer's edit of a file qa-tester wrote in this run", async () => {
    const cwd = project();
    const denials: string[] = [];
    const authorship = createTestAuthorship({
      cwd,
      onDeny: (_, why) => denials.push(why),
    });
    await fire(authorship, "PostToolUse", "qa-tester", "Write", {
      file_path: join(cwd, "src/__tests__/export.test.ts"),
      content: "test",
    });
    const why = await fire(
      authorship,
      "PreToolUse",
      "backend-engineer",
      "Edit",
      {
        file_path: join(cwd, "src/__tests__/export.test.ts"),
        old_string: "a",
        new_string: "b",
      },
    );
    assert.match(why ?? "", /acceptance test qa-tester wrote/);
    assert.match(why ?? "", /spec gap/);
    assert.equal(denials.length, 1);
  });

  it("matches the file however its path is spelled, symlinks included", async () => {
    const cwd = project();
    writeFileSync(join(cwd, "src/__tests__/b.test.ts"), "x\n");
    symlinkSync(join(cwd, "src/__tests__"), join(cwd, "alias"));
    const authorship = createTestAuthorship({ cwd });
    await fire(authorship, "PostToolUse", "qa-tester", "Edit", {
      file_path: "src/__tests__/b.test.ts",
    });
    for (const file_path of [
      join(cwd, "src/__tests__/b.test.ts"),
      "./src/__tests__/b.test.ts",
      "src/__tests__/../__tests__/b.test.ts",
      join(cwd, "alias/b.test.ts"),
    ]) {
      assert.ok(
        await fire(authorship, "PreToolUse", "frontend-engineer", "Write", {
          file_path,
        }),
        file_path,
      );
    }
  });

  it("lets qa-tester keep editing its own tests, and engineers edit everything else", async () => {
    const cwd = project();
    const authorship = createTestAuthorship({ cwd });
    await fire(authorship, "PostToolUse", "qa-tester", "Write", {
      file_path: "src/__tests__/c.test.ts",
    });
    assert.equal(
      await fire(authorship, "PreToolUse", "qa-tester", "Edit", {
        file_path: "src/__tests__/c.test.ts",
      }),
      undefined,
    );
    assert.equal(
      await fire(authorship, "PreToolUse", "backend-engineer", "Edit", {
        file_path: "src/a.ts",
      }),
      undefined,
    );
    assert.equal(
      await fire(authorship, "PreToolUse", "backend-engineer", "Read", {
        file_path: "src/__tests__/c.test.ts",
      }),
      undefined,
    );
  });

  it("counts only writes that succeeded, and only qa-tester's", async () => {
    const cwd = project();
    const authorship = createTestAuthorship({ cwd });
    // A PreToolUse alone is not a write: the call may still be refused or fail.
    await fire(authorship, "PreToolUse", "qa-tester", "Write", {
      file_path: "src/__tests__/d.test.ts",
    });
    await fire(authorship, "PostToolUse", "backend-engineer", "Write", {
      file_path: "src/__tests__/e.test.ts",
    });
    assert.equal(
      await fire(authorship, "PreToolUse", "backend-engineer", "Edit", {
        file_path: "src/__tests__/d.test.ts",
      }),
      undefined,
    );
    assert.equal(
      await fire(authorship, "PreToolUse", "mobile-developer", "Edit", {
        file_path: "src/__tests__/e.test.ts",
      }),
      undefined,
    );
    assert.deepEqual(authorship.files(), []);
  });

  it("lists the files qa-tester wrote, relative to the project", async () => {
    const cwd = project();
    const authorship = createTestAuthorship({ cwd });
    await fire(authorship, "PostToolUse", "qa-tester", "Write", {
      file_path: join(cwd, "src/__tests__/z.test.ts"),
    });
    await fire(authorship, "PostToolUse", "qa-tester", "MultiEdit", {
      file_path: "src/__tests__/a.test.ts",
    });
    assert.deepEqual(authorship.files(), [
      "src/__tests__/a.test.ts",
      "src/__tests__/z.test.ts",
    ]);
  });
});

describe("review round 1: the same file under another name is still the test", () => {
  async function owned(name: string) {
    const cwd = project();
    writeFileSync(join(cwd, name), "test\n");
    const authorship = createTestAuthorship({ cwd });
    await fire(authorship, "PostToolUse", "qa-tester", "Write", { file_path: name });
    const edit = (file_path: string) =>
      fire(authorship, "PreToolUse", "backend-engineer", "Edit", { file_path, old_string: "a", new_string: "b" });
    return { cwd, edit };
  }

  it("through a hard link", async () => {
    const { cwd, edit } = await owned("src/__tests__/a.test.ts");
    linkSync(join(cwd, "src/__tests__/a.test.ts"), join(cwd, "src/hard.ts"));
    assert.ok(await edit("src/hard.ts"));
  });

  it("after its directory is renamed", async () => {
    const { cwd, edit } = await owned("src/__tests__/a.test.ts");
    renameSync(join(cwd, "src/__tests__"), join(cwd, "src/moved"));
    assert.ok(await edit("src/moved/a.test.ts"));
  });

  it("spelled in another case, where the filesystem ignores case", async () => {
    const { cwd, edit } = await owned("src/__tests__/Case.test.ts");
    if (!existsSync(join(cwd, "src/__tests__/case.test.ts"))) return; // case-sensitive filesystem
    assert.ok(await edit("src/__tests__/case.test.ts"));
    assert.ok(await edit("SRC/__TESTS__/CASE.TEST.TS"));
  });

  it("after it is deleted and written again at the same path", async () => {
    const { cwd, edit } = await owned("src/__tests__/a.test.ts");
    rmSync(join(cwd, "src/__tests__/a.test.ts"));
    assert.ok(await edit("src/__tests__/a.test.ts"));
  });
});

describe("review round 2: only tests are locked, not the stubs qa-tester adds", () => {
  it("leaves a source stub qa-tester wrote editable by the engineer who implements it", async () => {
    const cwd = project();
    const authorship = createTestAuthorship({ cwd });
    await fire(authorship, "PostToolUse", "qa-tester", "Write", { file_path: "src/export.ts" });
    await fire(authorship, "PostToolUse", "qa-tester", "Write", { file_path: "src/__tests__/export.test.ts" });
    assert.equal(
      await fire(authorship, "PreToolUse", "backend-engineer", "Edit", { file_path: "src/export.ts" }),
      undefined,
    );
    assert.ok(await fire(authorship, "PreToolUse", "backend-engineer", "Edit", { file_path: "src/__tests__/export.test.ts" }));
    assert.deepEqual(authorship.files(), ["src/__tests__/export.test.ts"]);
  });

  it("treats the usual test layouts as tests", async () => {
    const cwd = project();
    const authorship = createTestAuthorship({ cwd });
    const tests = [
      "src/a.test.ts",
      "src/b.spec.tsx",
      "web/c.spec.js",
      "src/__tests__/d.ts",
      "e2e/screens/e.e2e.ts",
      "mobile/maestro/flows/login.yaml",
      "test/f.mjs",
      "functions/tests/g.ts",
      "regroup/mobile/src/h.integration.test.ts",
    ];
    for (const file_path of [...tests, "src/stub.ts", "src/testing-utils.ts", "README.md"]) {
      await fire(authorship, "PostToolUse", "qa-tester", "Write", { file_path });
    }
    assert.deepEqual(authorship.files(), [...tests].sort());
  });
});


describe("review round 3: tests named by other runners' conventions are tests too", () => {
  it("locks and lists them, and leaves look-alike source and docs alone", async () => {
    const cwd = project();
    const authorship = createTestAuthorship({ cwd });
    const tests = [
      "api/test_export.py",
      "api/export_test.py",
      "svc/export_test.go",
      "cypress/e2e/login.cy.ts",
      "spec/models/user_spec.rb",
      "src/export.test.mts",
    ];
    const notTests = ["src/latest.ts", "src/contest.py", "docs/export.spec.md", "src/snaps/a.test.ts.snap"];
    for (const file_path of [...tests, ...notTests]) {
      await fire(authorship, "PostToolUse", "qa-tester", "Write", { file_path });
    }
    assert.deepEqual(authorship.files(), [...tests].sort());
    for (const file_path of tests) {
      assert.ok(await fire(authorship, "PreToolUse", "backend-engineer", "Edit", { file_path }), file_path);
    }
  });
});

describe("review round 4: .NET and Xcode test layouts", () => {
  it("locks CamelCase test projects and files, and leaves look-alikes alone", async () => {
    const cwd = project();
    const authorship = createTestAuthorship({ cwd });
    const tests = [
      "MyApp.Tests/UserTests.cs",
      "MyAppTests/LoginTests.swift",
      "Sources/App/LoginTest.swift",
      "app/src/androidTest/java/ExportTest.kt",
      "Tests/AppTests/ExportTests.swift",
    ];
    const notTests = ["src/latest/index.ts", "src/contests/Latest.java", "src/Contest.cs", "src/models/ABTest.ts"];
    for (const file_path of [...tests, ...notTests]) {
      await fire(authorship, "PostToolUse", "qa-tester", "Write", { file_path });
    }
    assert.deepEqual(authorship.files(), [...tests].sort());
  });
});
