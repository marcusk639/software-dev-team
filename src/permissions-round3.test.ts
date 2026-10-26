/**
 * Round-3 review findings (PR #4), each fed to the policy exactly as the
 * reviewer reproduced it. Every deny pins its reason.
 */
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  approvalReason,
  createPolicy,
  denyReason,
  type Policy,
} from "./permissions.js";

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

const OUTSIDE = /is outside the project/;
const CONFIG = /may write to git internals or agent configuration/;

function needsApproval(cases: Case[], p: Policy = policy) {
  for (const [tool, input] of cases) {
    it(`asks before ${tool} ${JSON.stringify(input)}`, () => {
      const got = approvalReason(p, tool, input);
      assert.ok(got !== null, "expected an approval reason");
      assert.match(got, OUTSIDE);
    });
  }
}

function noApproval(cases: Case[], p: Policy = policy) {
  for (const [tool, input] of cases) {
    it(`needs no approval for ${tool} ${JSON.stringify(input)}`, () => {
      assert.equal(approvalReason(p, tool, input), null);
    });
  }
}

describe("I1: a Glob pattern, or a Grep glob, cannot reach outside --cwd", () => {
  needsApproval([
    ["Glob", { pattern: "/etc/*" }],
    ["Glob", { pattern: "../../**/*" }],
    ["Glob", { pattern: "~/.ssh/*" }],
    ["Glob", { pattern: "../../*", path: "src" }],
    ["Glob", { pattern: "*.conf", path: "/etc" }],
    ["Grep", { pattern: "x", glob: "/etc/**" }],
    ["Grep", { pattern: "x", glob: "*.ts,../../**/*.ts" }],
    ["Grep", { pattern: "x", glob: "~/.aws/*" }],
  ]);
  noApproval([
    ["Glob", { pattern: "**/*.ts" }],
    ["Glob", { pattern: "src/**/*.test.ts" }],
    ["Glob", { pattern: `${project}/src/*.ts` }],
    ["Glob", { pattern: "../a.ts", path: "src" }],
    ["Grep", { pattern: "x", glob: "*.{ts,tsx}" }],
    ["Grep", { pattern: "x", glob: "!**/node_modules/**", path: "src" }],
  ]);
});

describe("I2: a variable inside a word cannot spell a secret or protected path", () => {
  denies(ENV_OR_SECRET, [
    bash('f=.en; cat "$f"v'),
    bash("f=.en; cat ${f}v"),
    bash('k=id_r; cat ~/.ssh/"$k"sa'),
    bash("for v in ${!A*}; do echo $v=${!v}; done"),
    bash("n=ANTHROPIC_API_KEY; echo ${!n}"),
  ]);
  denies(CONFIG, [
    bash('u=U; cp src/a.ts CLA"$u"DE.md'),
    bash('d=.gi; cp src/a.ts "$d"t/hooks/pre-commit'),
    bash('c=claude; cp x ."$c"/settings.json'),
  ]);
  allows([
    bash('cat "$FILE"'),
    bash('cp "$SRC"/a.ts dist/'),
    bash('echo "${name}.json"'),
    bash('ls "$HOME"/projects'),
    bash('node "$DIR"/scripts/build.js'),
    bash('for f in src/*.ts; do echo "$f"; done'),
  ]);
});

describe("approval: only this session's own directory is exempt, and symlinks are followed", () => {
  const transcripts = join(root, "transcripts");
  const transcript = join(transcripts, "s.jsonl");
  mkdirSync(join(transcripts, "s"), { recursive: true });
  const read = (file_path: string) =>
    approvalReason(policy, "Read", { file_path }, transcript);

  it("lets a session read its own saved tool results", () => {
    assert.equal(read(join(transcripts, "s", "tool-result.txt")), null);
  });
  for (const path of [
    join(transcripts, "other", "x"),
    `${join(transcripts, "s")}/../other/x`,
    transcript,
    join(transcripts, "s-evil", "x"),
  ]) {
    it(`asks before reading ${path.slice(root.length)}`, () => {
      assert.match(read(path) ?? "", OUTSIDE);
    });
  }

  it("follows a symlink in --cwd that leads outside it", () => {
    mkdirSync(join(project, "links"), { recursive: true });
    symlinkSync("/etc", join(project, "links", "etclink"));
    assert.match(
      approvalReason(policy, "Read", { file_path: "links/etclink/hosts" }) ?? "",
      OUTSIDE,
    );
    assert.match(
      approvalReason(policy, "Glob", { pattern: "links/etclink/*" }) ?? "",
      OUTSIDE,
    );
  });
});
