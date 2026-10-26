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

describe("I3: commit and PR messages are judged without their text", () => {
  allows([
    bash('git commit -m "docs: explain why git reset --hard is blocked"'),
    bash('git commit -m "fix: stop rm -rf in cleanup script"'),
    bash("git commit -am 'chore: never git push --force'"),
    bash('gh pr create --title x --body "never run git push --force"'),
    bash('gh pr create -t "drop git clean -fd" -b "printenv was removed"'),
    bash('gh issue create --title "rm -rf in setup.sh" --body "see git reset --hard"'),
    bash('gh pr comment 4 --body "the hook blocks rm -rf ~"'),
    bash('gh pr edit 4 --body "explains git config alias.x"'),
    bash('git tag -a v1 -m "rm -rf is blocked now"'),
    bash('git notes add -m "git push --force is refused"'),
    bash(
      "git commit -m \"$(cat <<'EOF'\nfix: ignore .env files\n\ngit reset --hard is blocked\nEOF\n)\"",
    ),
    bash(
      'git commit -m "$(cat <<"EOF"\nfix: stop rm -rf in cleanup\nEOF\n)"',
    ),
  ]);
  denies(SAFETY("recursive delete"), [
    bash('git commit -m "$(rm -rf src)"'),
    bash("git commit -m 'x' && rm -rf src"),
    bash('git commit -m "`rm -rf src`"'),
    // An unquoted heredoc expands its body.
    bash('git commit -m "$(cat <<EOF\n$(rm -rf src)\nEOF\n)"'),
    // A heredoc outside a message runs as a command.
    bash("$(cat <<'EOF'\nrm -rf src\nEOF\n)"),
    bash("bash <<'EOF'\nrm -rf src\nEOF"),
    // A message flag on another command is not a message.
    bash("bash -cm 'rm -rf src'"),
  ]);
  denies(ENV_OR_SECRET, [
    bash('git commit -m "$(cat .env)"'),
    bash("bash -cm 'cat .env'"),
    bash("sh -cm 'printenv'"),
  ]);
});

describe("I4: delegations run in the checkout, never in an isolated copy", () => {
  denies(/Delegate without isolation/, [
    ["Agent", { subagent_type: "qa-tester", prompt: "p", isolation: "worktree" }],
    ["Task", { subagent_type: "qa-tester", prompt: "p", isolation: "remote" }],
    ["Agent", { subagent_type: "qa-tester", prompt: "p", isolation: "" }],
  ]);
  allows([["Agent", { subagent_type: "qa-tester", prompt: "p" }]]);
});

describe("I5: more commands that destroy work are hard-denied", () => {
  denies(SAFETY("discards uncommitted work"), [
    bash("git read-tree -u --reset HEAD"),
    bash("git read-tree -u -m HEAD"),
    bash("git read-tree --reset HEAD"),
    bash("git -C . read-tree -um HEAD"),
  ]);
  denies(SAFETY("recursive delete"), [
    bash("rsync -a --delete /tmp/empty/ src/"),
    bash("rsync -a --delete-after x/ src/"),
    bash("rsync -av --del a/ b/"),
    bash("rsync --remove-source-files -a src/ /tmp/x/"),
  ]);
  denies(SAFETY("deletes a GitHub repository or resource"), [
    bash("gh repo delete me/repo --yes"),
    bash("gh api -X DELETE repos/me/repo"),
    bash("gh api repos/me/repo --method DELETE"),
    bash("gh api repos/me/repo --method=delete"),
    bash("gh api -XDELETE repos/me/repo/git/refs/heads/main"),
  ]);
  allows([
    bash("git read-tree HEAD"),
    bash("rsync -a src/ /tmp/backup/"),
    bash("gh api repos/me/repo"),
    bash("gh api -X POST repos/me/repo/issues -f title=x"),
    bash("gh repo view"),
    bash('gh pr create --title "x" --body "gh repo delete is blocked"'),
  ]);
});

describe("false positives: no-op git editors and .env.ts source files", () => {
  allows([
    bash("GIT_EDITOR=true git rebase --continue"),
    bash("GIT_SEQUENCE_EDITOR=true git rebase -i HEAD~2"),
    bash("GIT_EDITOR=: git commit --amend"),
    bash("git -c core.editor=true rebase --continue"),
    bash("git -c sequence.editor=true rebase -i HEAD~2"),
    bash("git -c core.editor=: commit --amend"),
    ["Grep", { pattern: "x", glob: "*.env.ts" }],
    ["Grep", { pattern: "x", glob: "**/.env.d.ts" }],
    ["Read", { file_path: "src/config/.env.ts" }],
    bash("cat src/.env.ts"),
  ]);
  denies(SAFETY("changes what git runs"), [
    bash("GIT_EDITOR=vim git commit"),
    bash("GIT_EDITOR='sh -c id' git commit"),
    bash("GIT_SEQUENCE_EDITOR=./x.sh git rebase -i HEAD~2"),
    bash("git -c core.editor=./evil.sh commit --amend"),
    bash("git -c sequence.editor='sh x' rebase -i HEAD~2"),
  ]);
  denies(/holds secrets|search targets files that hold secrets|reads secrets/, [
    ["Grep", { pattern: "x", glob: "*.env.local" }],
    ["Grep", { pattern: "x", glob: ".env.production" }],
    ["Read", { file_path: ".env.local" }],
    ["Read", { file_path: ".env" }],
    bash("cat .env.production"),
  ]);
});
