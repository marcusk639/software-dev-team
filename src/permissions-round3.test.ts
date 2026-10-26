/**
 * Round-3 review findings (PR #4), each fed to the policy exactly as the
 * reviewer reproduced it. Every deny pins its reason.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createPolicy, denyReason, type Policy } from "./permissions.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sdt-round3-")));
const project = join(root, "project");
mkdirSync(join(project, "src"), { recursive: true });
writeFileSync(join(project, ".env"), "KEY=x\n");
writeFileSync(join(project, "src/a.ts"), "export {};\n");

const policy = createPolicy({
  cwd: project,
  agents: ["qa-tester"],
  pinnedModels: [],
  env: {},
});

type Case = [tool: string, input: Record<string, unknown>];
const bash = (command: string): Case => ["Bash", { command }];

function denies(reason: RegExp, cases: Case[], p: Policy = policy) {
  for (const [tool, input] of cases) {
    it(`denies ${tool} ${JSON.stringify(input)}`, () => {
      const got = denyReason(p, tool, input);
      assert.ok(got !== null, "expected a deny");
      assert.match(got, reason);
    });
  }
}

function allows(cases: Case[], p: Policy = policy) {
  for (const [tool, input] of cases) {
    it(`allows ${tool} ${JSON.stringify(input)}`, () => {
      const got = denyReason(p, tool, input);
      assert.equal(got, null, got ?? "");
    });
  }
}

const SAFETY = (why: string) =>
  new RegExp(`Blocked by the team's safety policy \\(${why}\\)`);
const ENV_OR_SECRET = /reads secrets or the process environment/;

describe("C1: a newline ends a command, so it cannot borrow a subcommand exemption", () => {
  denies(SAFETY("recursive delete"), [
    bash("docker\nrm -rf src"),
    bash("kubectl\nrm -rf ~"),
    bash("podman\nrm -rf src"),
    bash("helm\nrm -rf src"),
    bash("git\nrm -r -- src --cached"),
    bash("git\nrm -rf src"),
    // git's global options must not swallow the next line either.
    bash("git -C\nrm -rf src"),
    bash("git -C .\nrm -rf src"),
    bash("git --git-dir\nrm -rf src"),
  ]);
  denies(ENV_OR_SECRET, [
    bash("env\nls"),
    bash("export\nls"),
    bash("set\npwd"),
  ]);
  allows([
    bash("docker rm -f web"),
    bash("kubectl rm x"),
    bash("git rm -r --cached dist"),
    bash("git -C . rm -r --cached dist"),
    bash("git\tstatus"),
    bash("git status\nls"),
  ]);
});
