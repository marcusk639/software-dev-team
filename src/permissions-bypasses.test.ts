/**
 * Bypasses found in the PR #2 review, each fed to denyReason exactly as
 * reproduced. Every deny pins the reason it must give, so a case that starts
 * failing for an unrelated rule still shows up.
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
import { createPolicy, denyReason } from "./permissions.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sdt-bypass-")));
const project = join(root, "project");
const home = join(root, "home");
mkdirSync(join(project, "config"), { recursive: true });
mkdirSync(join(project, "src"), { recursive: true });
mkdirSync(join(home, ".ssh"), { recursive: true });
writeFileSync(join(project, ".env"), "KEY=x\n");
writeFileSync(join(project, "src/a.ts"), "export {};\n");
symlinkSync("../.env", join(project, "config/local"));
symlinkSync("../.env.prod", join(project, "config/dangling"));
symlinkSync(join(home, ".ssh"), join(project, "keys"));
symlinkSync("src/a.ts", join(project, "alias.ts"));

const SECRET = "sk-ant-test-0123456789abcdef";
const policy = createPolicy({
  cwd: project,
  agents: ["qa-tester"],
  pinnedModels: [],
  env: { ANTHROPIC_API_KEY: SECRET },
});

type Case = [tool: string, input: Record<string, unknown>];
const bash = (command: string): Case => ["Bash", { command }];

function denies(reason: RegExp, cases: Case[]) {
  for (const [tool, input] of cases) {
    it(`denies ${tool} ${JSON.stringify(input)}`, () => {
      const got = denyReason(policy, tool, input);
      assert.ok(got !== null, "expected a deny");
      assert.match(got, reason);
    });
  }
}

function allows(cases: Case[]) {
  for (const [tool, input] of cases) {
    it(`allows ${tool} ${JSON.stringify(input)}`, () => {
      const got = denyReason(policy, tool, input);
      assert.equal(got, null, got ?? "");
    });
  }
}

const FILE_SECRET = /That file holds secrets/;
const SEARCH_SECRET = /That search targets files that hold secrets/;
const SAFETY = (why: string) =>
  new RegExp(`Blocked by the team's safety policy \\(${why}\\)`);
const ENV_OR_SECRET = /reads secrets or the process environment/;
const CONFIG = /may write to git internals or agent configuration/;
const PROTECTED =
  /is not permitted \(secrets, git internals or agent configuration\)/;

describe("C1: reads are judged by the file they reach", () => {
  denies(FILE_SECRET, [
    ["Read", { file_path: "/proc/self/root/proc/self/environ" }],
    ["Read", { file_path: "/proc//self/environ" }],
    ["Read", { file_path: "/proc/self/./environ" }],
    ["Read", { file_path: "/proc/1/task/1/environ" }],
    ["Read", { file_path: "config/local" }],
    ["Read", { file_path: join(project, "config/local") }],
    ["Read", { file_path: "config/dangling" }],
    ["Read", { file_path: "src/../.env" }],
  ]);
  denies(SEARCH_SECRET, [
    ["Grep", { pattern: "KEY", path: "config/local" }],
    ["Grep", { pattern: "x", path: "keys" }],
    ["Grep", { pattern: "KEY", glob: "**/.e?v", output_mode: "content" }],
    ["Grep", { pattern: "KEY", glob: ".{env,x}" }],
    ["Grep", { pattern: "KEY", path: "/Users/me", glob: "**/.a?s/cred*" }],
    ["Grep", { pattern: "KEY", glob: "cred*" }],
    ["Grep", { pattern: "KEY", glob: "**/*.p?m" }],
    ["Grep", { pattern: "KEY", glob: "id_*" }],
    ["Grep", { pattern: "KEY", glob: "*.{pem,ts}" }],
  ]);
  allows([
    ["Read", { file_path: join(project, "src/a.ts") }],
    ["Read", { file_path: "alias.ts" }],
    ["Read", { file_path: "/proc/cpuinfo" }],
    ["Read", { file_path: join(project, "CLAUDE.md") }],
    ["Grep", { pattern: "x", path: project }],
    ["Grep", { pattern: "x", path: "src" }],
    ["Grep", { pattern: "x", glob: "*.ts" }],
    ["Grep", { pattern: "x", glob: "**/*.{ts,tsx}" }],
    ["Grep", { pattern: "x", glob: "*" }],
    ["Grep", { pattern: "x", glob: "**/*.json" }],
    ["Grep", { pattern: "x", glob: "**/*.md" }],
    ["Glob", { pattern: "**/*" }],
    // Round 2: Glob only lists names, so its pattern is no longer screened.
    ["Glob", { pattern: "**/cred*" }],
    ["Glob", { pattern: "**/.*" }],
    ["Glob", { pattern: "**/*.tfst?te" }],
    // Round 2: `*rc` also matches .eslintrc and .prettierrc, so it is a
    // config-file glob like `**/.*rc`, not one aimed at .npmrc.
    ["Grep", { pattern: "KEY", glob: "*rc" }],
    ["Glob", { pattern: "src/**/*.ts" }],
    ["Glob", { pattern: ".github/workflows/*.yml" }],
    ["Glob", { pattern: "**/environment.ts" }],
  ]);
});

describe("I1: git global options and flag order", () => {
  denies(SAFETY("force push or remote branch deletion"), [
    bash("git -P push --force origin main"),
    bash("git --exec-path=/x push --force"),
    bash("git --literal-pathspecs push --force"),
    bash("git --no-optional-locks push --force"),
    bash("git -C. push --force"),
    bash("git --git-dir=.git --work-tree=. push --force"),
    bash("git push --forc origin main"),
    bash("/usr/bin/git -P push -f"),
  ]);
  denies(SAFETY("changes what git runs"), [
    bash("git --exec-path=/x status"),
  ]);
  denies(SAFETY("discards uncommitted work"), [
    bash("git reset -q --hard HEAD~5"),
    bash("git reset --har HEAD~1"),
    bash("git -P reset --hard"),
  ]);
  denies(SAFETY("force-deletes a branch"), [
    bash("git branch --delete --force main"),
    bash("git branch -d -f main"),
    bash("git branch -df main"),
    bash("git branch -fd main"),
    bash("git branch -f -d main"),
    bash("git branch --del --forc main"),
    bash("git branch -D main"),
  ]);
  // Round 2: -f moves an existing branch, which can drop its commits.
  denies(SAFETY("rewrites a branch"), [bash("git branch -f topic origin/topic")]);
  allows([
    bash("git branch -d merged"),
    bash("git branch --delete merged"),
    bash("git reset --soft HEAD~1"),
    bash("git reset HEAD src/a.ts"),
    bash("git -P log --oneline"),
    bash("git --no-pager diff"),
    bash("git -C sub status"),
    bash("git push -u origin feature"),
  ]);
});

describe("I2: git config and alias tricks", () => {
  denies(SAFETY("changes what git runs"), [
    bash("git config --global include.path /tmp/evil"),
    bash("git config filter.x.clean sh"),
    bash("git config diff.x.textconv sh"),
    bash("git config core.gitProxy x"),
    bash("git config --glob alias.st status"),
    bash("git config user.name list"),
    bash("git --config-env=alias.st=X st"),
    bash("git --config-env alias.st=X st"),
    bash(
      "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.st GIT_CONFIG_VALUE_0='!rm -rf ~' git st",
    ),
    bash("export GIT_CONFIG_GLOBAL=/tmp/evil && git st"),
    bash("GIT_DIR=/tmp/x git status"),
    bash("GIT_EXEC_PATH=/tmp git status"),
    bash("GIT_SSH_COMMAND='sh -c x' git fetch"),
    bash("git -c include.path=/tmp/evil status"),
    bash("git -c filter.x.clean=sh add ."),
    bash("git -c alias.st=status st"),
    bash("git -c core.hooksPath=/tmp/h commit -m x"),
  ]);
  denies(CONFIG, [
    bash("printf '[alias]\\n st = !sh' >> ~/.gitconfig"),
    bash("cp x ~/.gitconfig"),
    bash("echo x > ~/.config/git/config"),
  ]);
  allows([
    bash("git config --get remote.origin.url"),
    bash("git config --get-regexp alias"),
    bash("git config --list"),
    bash("git config --global --list"),
    bash("git config -l"),
    bash("git config get user.name"),
    bash("git config list"),
    bash("git -c user.name=bot -c user.email=bot@x commit -m wip"),
    bash("git -c color.ui=always diff"),
    bash("git grep -c foo"),
    bash("git commit -c HEAD"),
    bash("GIT_PAGER=cat git log -3"),
    bash("cat ~/.gitconfig"),
  ]);
});

describe("I3: wildcards cannot spell a protected path", () => {
  denies(CONFIG, [
    bash("cp evil .gi?/hooks/pre-commit"),
    bash("cp evil .cl?ude/settings.json"),
    bash("cp evil .mcp.js?n"),
    bash("cp evil ./.g*/hooks/pre-commit"),
    bash("cp evil sub/.cl[a]ude/settings.json"),
    bash("cp evil {.git,x}/hooks/pre-commit"),
    bash("cp evil CLAUD?.md"),
    bash("cp evil C*.md"),
  ]);
  allows([
    bash("ls .gi?/hooks"),
    bash("cat .cl?ude/settings.json"),
    bash("cp src/*.ts dist/"),
    bash("rm -f *.log"),
    bash("mv build/*.js out/"),
  ]);
});

describe("I4: CLAUDE.md persists like .claude/", () => {
  denies(PROTECTED, [
    ["Write", { file_path: join(project, "CLAUDE.md") }],
    ["Edit", { file_path: join(project, "CLAUDE.md") }],
    ["Edit", { file_path: join(project, "src/CLAUDE.md") }],
    ["Write", { file_path: join(project, "CLAUDE.local.md") }],
    ["MultiEdit", { file_path: join(project, "claude.md") }],
  ]);
  denies(CONFIG, [
    bash("echo x >> CLAUDE.md"),
    bash("sed -i 's/a/b/' CLAUDE.md"),
    bash("cp evil.md src/CLAUDE.local.md"),
  ]);
  allows([
    ["Write", { file_path: join(project, "docs/CLAUDE-notes.md") }],
    ["Edit", { file_path: join(project, "README.md") }],
    bash("cat CLAUDE.md"),
    bash("grep -n x CLAUDE.md"),
    bash('git commit -m "docs: update CLAUDE.md"'),
  ]);
});

describe("I5: quoting and spelling cannot hide a destructive command", () => {
  denies(SAFETY("recursive delete"), [
    bash("r''m -rf src"),
    bash('r""m -rf src'),
    bash("eval 'r''m -rf src'"),
    bash("pnpm   rm -rf /"),
    bash("pnpm rm -rf /"),
    bash("npm rm /etc"),
    bash("yarn rm -f ~/x"),
    bash("rm --rec src"),
  ]);
  denies(SAFETY("bulk delete through find"), [
    bash("find . -type f -exec /bin/rm {} +"),
    bash("find . -ok rm {} \\;"),
    bash("find . -okdir rm {} \\;"),
    bash("find . -execdir /usr/bin/rm -f {} +"),
  ]);
  denies(ENV_OR_SECRET, [
    bash("/usr/bin/env"),
    bash("ENV=1 env"),
    bash("\\env"),
    bash("builtin set"),
    bash("env -i"),
    bash("env -u X"),
    bash("env FOO=1"),
    bash("e''nv"),
    bash("cat .e''nv"),
    bash('cat ".e"nv'),
    bash("cat {.env,x}"),
    bash("cat /proc/1/task/1/environ"),
  ]);
  allows([
    bash("pnpm rm lodash"),
    bash("npm rm left-pad"),
    bash("yarn rm react"),
    bash("env FOO=1 pnpm test"),
    bash("env -u X pnpm test"),
    bash("/usr/bin/env node script.js"),
    bash("find . -name '*.ts' -exec grep -l x {} +"),
    bash("echo 'rm is a command'"),
    bash("ls env"),
    bash("set -euo pipefail; pnpm test"),
  ]);
});

describe("credential detection limits (pinned so the scope is explicit)", () => {
  denies(/contains the value of a credential/, [
    bash(`echo ${SECRET}`),
    ["Agent", { subagent_type: "qa-tester", prompt: `use ${SECRET}` }],
  ]);
  // Only the exact value is matched. A changed case or a value assembled from
  // pieces is not detected; the env-dump rules are the other half.
  allows([
    bash(`echo ${SECRET.toUpperCase()}`),
    bash("A=sk-ant-test-; B=0123456789abcdef; echo $A$B"),
  ]);
});
