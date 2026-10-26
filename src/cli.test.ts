import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkProjectDir, parseArgs } from "./cli.js";

describe("parseArgs", () => {
  it("collects repeated --allow rules", () => {
    const cli = parseArgs([
      "--allow",
      "Bash(pnpm test:*)",
      "--allow",
      "Bash(pnpm lint)",
      "fix it",
    ]);
    assert.ok("task" in cli);
    assert.deepEqual(cli.allow, ["Bash(pnpm test:*)", "Bash(pnpm lint)"]);
    assert.equal(cli.task, "fix it");
  });

  it("takes --resume with the answer as the task", () => {
    const cli = parseArgs([
      "--resume",
      "3f2a-session",
      "Use soft deletes; proceed",
    ]);
    assert.ok("task" in cli);
    assert.equal(cli.resume, "3f2a-session");
    assert.equal(cli.task, "Use soft deletes; proceed");
  });


  it("rejects --allow without a value", () => {
    assert.throws(() => parseArgs(["--allow"]), /--allow requires a value/);
  });

  it("defaults to no extra rules and no resume", () => {
    const cli = parseArgs(["do the thing"]);
    assert.ok("task" in cli);
    assert.deepEqual(cli.allow, []);
    assert.equal(cli.resume, undefined);
  });

  for (const bad of ["5abc", "1.5", "0", "-1"]) {
    it(`rejects --max-turns ${bad}`, () => {
      assert.throws(() => parseArgs(["--max-turns", bad, "task"]));
    });
  }

  it("--roles honours --cwd in either order", () => {
    assert.deepEqual(parseArgs(["--roles", "--cwd", "/p"]), { roles: true, cwd: "/p" });
    assert.deepEqual(parseArgs(["--cwd", "/p", "--roles"]), { roles: true, cwd: "/p" });
  });
});

describe("parseArgs: input that would otherwise be dropped or misread", () => {
  it("requires a message with --resume", () => {
    assert.throws(() => parseArgs(["--resume", "abc"]), /--resume needs a message/);
  });

  it("rejects empty option values", () => {
    assert.throws(() => parseArgs(["--cwd", "", "task"]), /--cwd requires a value/);
    assert.throws(() => parseArgs(["--resume", "", "msg"]), /--resume requires a value/);
  });

  it("rejects a task given both as a file and as text", () => {
    assert.throws(() => parseArgs(["--file", "t.md", "also this"]), /either --file or a task/);
  });
});

describe("checkProjectDir", () => {
  it("accepts a directory", () => {
    assert.doesNotThrow(() => checkProjectDir(tmpdir()));
  });

  it("rejects a path that does not exist or is not a directory", () => {
    assert.throws(() => checkProjectDir(join(tmpdir(), "sdt-no-such-dir-x")), /not a directory/);
    const file = join(mkdtempSync(join(tmpdir(), "sdt-cli-")), "f.txt");
    writeFileSync(file, "x");
    assert.throws(() => checkProjectDir(file), /not a directory/);
  });
});

describe("--max-budget", () => {
  it("parses a dollar amount", () => {
    const cli = parseArgs(["--max-budget", "2.50", "task"]);
    assert.ok("task" in cli);
    assert.equal(cli.maxBudgetUsd, 2.5);
  });

  for (const bad of ["0", "-1", "abc", "1e9x"]) {
    it(`rejects ${bad}`, () => {
      assert.throws(() => parseArgs(["--max-budget", bad, "task"]), /--max-budget/);
    });
  }
});
