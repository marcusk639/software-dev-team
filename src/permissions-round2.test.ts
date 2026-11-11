/**
 * Round-2 review findings, each fed to the policy exactly as the reviewer
 * reproduced it (real git 2.55, SDK 0.3.283). Every deny pins its reason.
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
  createPolicy,
  createSafetyHooks,
  denyReason,
  type Policy,
} from "./permissions.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sdt-round2-")));
const project = join(root, "project");
const shared = join(root, "shared-docs");
mkdirSync(join(project, "config"), { recursive: true });
mkdirSync(shared, { recursive: true });
writeFileSync(join(project, ".env"), "KEY=x\n");
symlinkSync("../.env", join(project, "config/local"));

const policy = createPolicy({
  cwd: project,
  agents: ["qa-tester"],
  pinnedModels: [],
  env: {},
  readRoots: [shared],
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
const GIT_RUNS = SAFETY("changes what git runs");
const ENV_OR_SECRET = /reads secrets or the process environment/;
const CONFIG = /may write to git internals or agent configuration/;
const SEARCH_SECRET = /That search targets files that hold secrets/;

describe("R2-1: git config is judged by position", () => {
  denies(GIT_RUNS, [
    bash("git config core.hooksPath /tmp/h -l"),
    bash("git config alias.zz '!x' --get"),
    bash("git config alias.q1 '!y' --list"),
    bash("git config alias.q3 '!y' --get-regexp"),
    bash("git config alias.st '!sh' # --list"),
    bash("git config alias.st '!sh -c id --list'"),
    bash('git config alias.st "!sh --get"'),
    bash("git config --get alias.st || git config alias.st x"),
    bash("git config --unset user.name"),
    bash("git config -e"),
    bash("git -C . config alias.x status"),
    bash("git clone --config core.hooksPath=/tmp/h https://x/r.git"),
    bash("git clone -c alias.x='!sh' https://x/r.git"),
    bash("git clone --config=filter.x.clean=sh https://x/r.git"),
    bash("git clone -c diff.x.textconv=sh https://x/r.git"),
    bash("git clone -c http.proxy=http://evil https://x/r.git"),
  ]);
  denies(CONFIG, [
    bash("echo '[alias]' > $XDG_CONFIG_HOME/git/config"),
    bash("echo '[alias]' >> ${XDG_CONFIG_HOME}/git/config"),
    bash("cp x ~/.config/git/config"),
  ]);
  allows([
    bash("git config user.name"),
    bash("git config --global user.email"),
    bash("git config --get user.name"),
    bash("git config --global --get user.email"),
    bash("git config --list --show-origin"),
    bash("git config -l"),
    bash("git config get user.name"),
    bash("git config list"),
    bash("git config --get-regexp alias"),
    bash("git clone --config core.autocrlf=false https://x/r.git"),
    bash("git clone https://x/r.git"),
  ]);
});

describe("R2-2: a backslash-newline joins words, as bash does", () => {
  denies(SAFETY("recursive delete"), [
    bash("r\\\nm -rf src"),
    bash("rm -\\\nrf src"),
  ]);
  denies(SAFETY("force push or remote branch deletion"), [
    bash("git pu\\\nsh --force"),
    bash("git push --fo\\\nrce"),
  ]);
  denies(ENV_OR_SECRET, [bash("e\\\nnv"), bash("cat .e\\\nnv")]);
  allows([bash("pnpm test \\\n  --reporter=dot")]);
});

describe("R2-3: Grep globs are judged piece by piece, the way ripgrep matches", () => {
  denies(SEARCH_SECRET, [
    ["Grep", { pattern: "KEY", glob: "**/?env" }],
    ["Grep", { pattern: "KEY", glob: "**/?env*" }],
    ["Grep", { pattern: "KEY", glob: "**/[!a]env" }],
    ["Grep", { pattern: "KEY", glob: "*.ts cred*" }],
    ["Grep", { pattern: "KEY", glob: "*.ts *.p?m" }],
    ["Grep", { pattern: "KEY", glob: "*.ts,?env" }],
    ["Grep", { pattern: "KEY", glob: "{**/*.ts,**/?env}" }],
    ["Grep", { pattern: "KEY", glob: "**/?npmrc" }],
    ["Grep", { pattern: "KEY", glob: "**/?netrc" }],
    ["Grep", { pattern: "KEY", glob: "**/?aws/*" }],
    ["Grep", { pattern: "KEY", glob: "**/.\\env" }],
    ["Grep", { pattern: "KEY", glob: "!*.ts" }],
    ["Grep", { pattern: "KEY", glob: "*.key" }],
  ]);
  denies(/outside the project/, [
    ["Grep", { pattern: "KEY", path: "/Users/me", output_mode: "content" }],
    ["Grep", { pattern: "KEY", path: "..", output_mode: "content" }],
  ]);
  allows([
    ["Grep", { pattern: "KEY" }],
    ["Grep", { pattern: "KEY", output_mode: "content" }],
    ["Grep", { pattern: "KEY", path: "config", output_mode: "content" }],
    ["Grep", { pattern: "KEY", path: shared, output_mode: "content" }],
    ["Grep", { pattern: "x", glob: ".eslintrc*" }],
    ["Grep", { pattern: "x", glob: ".prettierrc*" }],
    ["Grep", { pattern: "x", glob: "**/.*rc" }],
    ["Grep", { pattern: "x", glob: "*rc*" }],
    ["Grep", { pattern: "x", glob: "**/*.k*" }],
    ["Grep", { pattern: "x", glob: "**/*.json" }],
    ["Grep", { pattern: "x", glob: "*.ts,*.tsx" }],
    ["Grep", { pattern: "x", glob: "*" }],
  ]);
});

describe("R2-7: Glob only lists names, so its pattern is not screened", () => {
  allows([
    ["Glob", { pattern: "**/.env*" }],
    ["Glob", { pattern: "**/cred*" }],
    ["Glob", { pattern: "**/.*" }],
  ]);
  denies(/That search targets files that hold secrets/, [
    ["Glob", { pattern: "*", path: "config/local" }],
  ]);
});

describe("R2-4: reading a secret through a wildcard, a link or a substitution", () => {
  denies(ENV_OR_SECRET, [
    bash("cat .e?v"),
    bash("cat ./.e?v"),
    bash("cat .en[v]"),
    bash("cat .e*"),
    bash("head .e*"),
    bash("cat ~/.ss?/id_*"),
    bash("cat ~/.ss*/i*"),
    bash("cat ~/.a*/credentials"),
    bash("cat /proc/self/env?ron"),
    bash("tr '\\0' '\\n' < /proc/self/env*"),
    bash("grep -r KEY . --include='.e*'"),
    bash("rg --hidden KEY"),
    bash("rg -uu KEY"),
    bash("rg -uuu KEY"),
    // -u stops honouring .gitignore, which is where secret files are kept out.
    bash("rg -u KEY"),
    bash("rg -. KEY"),
    bash("gh auth token"),
    bash("gh auth status --show-token"),
    bash("git credential fill"),
    bash("echo url=https://github.com | git credential fill"),
    bash("cat config/local"),
    bash("head -5 ./config/local"),
    bash("cat $(echo x)"),
    bash("cat `ls`"),
    bash("grep KEY $(git ls-files)"),
  ]);
  allows([
    bash("cat src/a.ts"),
    bash("cat *.md"),
    bash("ls -la .github/*"),
    bash("rg KEY src"),
    bash("grep -r KEY src --include='*.ts'"),
    bash("echo $(date)"),
    bash("gh pr view 12"),
  ]);
});

describe("R2-5: environment dumps behind wrappers", () => {
  denies(ENV_OR_SECRET, [
    bash("bash -c env"),
    bash("bash -c 'env'"),
    bash("sh -c 'printenv'"),
    bash("eval env"),
    bash("eval 'env'"),
    bash("nice env"),
    bash("nice -n 5 env"),
    bash("timeout 5 env"),
    bash("stdbuf -o0 env"),
    bash("xargs env < /dev/null"),
    bash("! env"),
    bash("doas env"),
    bash("sudo -E env"),
    bash("watch env"),
    bash("script -q /dev/null env"),
    bash("command env"),
    bash("exec env"),
    bash("time set"),
    bash("eval 'export -p'"),
    bash("bash -c 'declare -x'"),
    bash("node -p 'JSON.stringify(process.env)'"),
    bash("node -e 'console.log(require(\"process\").env)'"),
    bash("python3 -c 'import os; print(dict(os.environ))'"),
    bash("ruby -e 'p ENV.to_h'"),
    bash("perl -e 'print %ENV'"),
  ]);
  allows([
    bash("nice -n 5 pnpm test"),
    bash("timeout 60 pnpm test"),
    bash("bash -c 'pnpm test'"),
    bash("node -e 'console.log(1+1)'"),
    bash("xargs grep -l TODO < files.txt"),
  ]);
});

describe("R2-6: destructive git and indirect deletes", () => {
  denies(SAFETY("force-deletes a branch|rewrites a branch"), [
    bash("git branch -M x main"),
    bash("git branch --force main HEAD~5"),
    bash("git branch -f topic origin/topic"),
    bash("git branch -C x main"),
  ]);
  denies(SAFETY("rewrites refs or drops history"), [
    bash("git update-ref -d refs/heads/main"),
    bash("git update-ref refs/heads/main HEAD~5"),
    bash("git reflog expire --expire=now --all"),
    bash("git reflog delete HEAD@{1}"),
    bash("git gc --prune=now"),
    bash("git gc --prune=all"),
    bash("git prune"),
  ]);
  denies(SAFETY("discards uncommitted work"), [
    bash("git worktree remove --force ../x"),
    bash("git worktree remove -f ../x"),
  ]);
  denies(SAFETY("recursive delete"), [
    bash("git rm -r src"),
    bash("xargs rm < files.txt"),
    bash("xargs -0 rm -f < files.txt"),
    bash("find . -name '*.ts' | xargs /bin/rm"),
  ]);
  denies(SAFETY("deletes files with uncommitted changes"), [
    bash("git rm -rf src"),
  ]);
  denies(SAFETY("bulk delete through find"), [
    bash("find . -exec busybox rm {} +"),
    bash("find . -exec sudo rm {} \\;"),
  ]);
  denies(SAFETY("hides the command it runs"), [
    bash("$'\\x72m' -rf x"),
    bash("A=rm; $A -rf x"),
    bash("${RM:-rm} -rf x"),
    bash("rm${IFS}-rf x"),
    bash("X=$IFS; echo"),
    bash("for c in rm; do $c -rf x; done"),
  ]);
  allows([
    bash("git rm -r --cached node_modules"),
    bash("git rm src/a.ts"),
    bash("git gc"),
    bash("git worktree remove ../x"),
    bash("git branch new-feature"),
    bash("git branch -d merged"),
    bash("git update-index --refresh"),
    bash("echo $HOME"),
    bash('echo "$PATH"'),
    bash("$(npm bin)/tsc --noEmit"),
  ]);
});

describe("R2-7: messages after combined short flags are messages", () => {
  allows([
  ]);
  denies(CONFIG, [bash("git commit -am x && echo y > CLAUDE.md")]);
});

describe("R2-3: reads outside the project need approval", () => {
  const hookFor = (p: Policy) => {
    const hook = createSafetyHooks(p).PreToolUse[0]!.hooks[0]!;
    return async (tool_name: string, tool_input: Record<string, unknown>) =>
      (await hook(
        {
          hook_event_name: "PreToolUse",
          session_id: "s",
          transcript_path: join(root, "transcripts", "s.jsonl"),
          cwd: project,
          tool_name,
          tool_use_id: "t1",
          tool_input,
          agent_id: "a1",
          agent_type: "qa-tester",
        },
        "t1",
        { signal: new AbortController().signal },
      )) as {
        continue?: boolean;
        hookSpecificOutput?: {
          permissionDecision?: string;
          permissionDecisionReason?: string;
        };
      };
  };
  const unattended = hookFor(policy);
  const interactive = hookFor(
    createPolicy({
      cwd: project,
      agents: ["qa-tester"],
      pinnedModels: [],
      env: {},
      interactive: true,
    }),
  );
  const outside = [
    ["Read", { file_path: "/etc/hosts" }],
    ["Read", { file_path: join(root, "notes.txt") }],
    ["Grep", { pattern: "x", path: "/Users/me" }],
    ["Glob", { pattern: "*", path: "/Users/me" }],
  ] as const;

  for (const [tool, input] of outside) {
    it(`denies ${tool} ${JSON.stringify(input)} under --yes`, async () => {
      const out = await unattended(tool, input);
      assert.equal(out.hookSpecificOutput?.permissionDecision, "deny");
      assert.match(
        out.hookSpecificOutput?.permissionDecisionReason ?? "",
        /outside the project/,
      );
    });
    it(`asks for ${tool} ${JSON.stringify(input)} when interactive`, async () => {
      const out = await interactive(tool, input);
      assert.equal(out.hookSpecificOutput?.permissionDecision, "ask");
    });
  }

  for (const input of [
    { file_path: join(project, "config/../README.md") },
    { file_path: join(shared, "guide.md") },
    { file_path: join(root, "transcripts", "s", "tool-results", "x.txt") },
  ]) {
    it(`lets Read ${input.file_path} through`, async () => {
      assert.deepEqual(await unattended("Read", input), { continue: true });
    });
  }
});

describe("R2-7: names are not contents", () => {
  allows([
    bash("ls -d .*"),
    bash("ls -la .e*"),
    bash("echo .e*"),
    ["Grep", { pattern: "x", glob: "!**/node_modules/**" }],
    ["Grep", { pattern: "x", glob: "*.ts !dist/" }],
  ]);
  denies(ENV_OR_SECRET, [bash("ls -d .* && cat .e*")]);
  denies(SEARCH_SECRET, [["Grep", { pattern: "x", glob: "!**/*.ts" }]]);
});
