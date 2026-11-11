import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { changedFiles } from "./changed-files.js";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "sdt-changed-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: dir });
  git("init", "-q");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/a.ts"), "a\n");
  writeFileSync(join(dir, "src/b.ts"), "b\n");
  git("add", ".");
  git("commit", "-qm", "init");
  return dir;
}

describe("changedFiles", () => {
  it("lists modified, added, untracked and renamed paths, sorted", () => {
    const dir = repo();
    writeFileSync(join(dir, "src/a.ts"), "changed\n");
    mkdirSync(join(dir, "src/new"));
    writeFileSync(join(dir, "src/new/c test.ts"), "c\n");
    renameSync(join(dir, "src/b.ts"), join(dir, "src/b2.ts"));
    execFileSync("git", ["add", "-A", "src/b.ts", "src/b2.ts"], { cwd: dir });
    assert.deepEqual(changedFiles(dir), ["src/a.ts", "src/b.ts", "src/b2.ts", "src/new/c test.ts"]);
  });

  it("is empty for a clean checkout", () => {
    assert.deepEqual(changedFiles(repo()), []);
  });

  it("is null outside a git checkout", () => {
    assert.equal(changedFiles(mkdtempSync(join(tmpdir(), "sdt-nogit-"))), null);
  });
});
