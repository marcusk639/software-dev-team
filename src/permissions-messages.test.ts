/**
 * Message stripping, round 3 ruling: messages are dropped only from a single
 * simple git/gh command whose message values are literal quoted spans, or
 * from Claude Code's exact commit heredoc. Everything else is screened whole.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { bashDenyReason } from "./permissions.js";

const project = realpathSync(mkdtempSync(join(tmpdir(), "sdt-messages-")));
mkdirSync(join(project, "src"));

function denies(reason: RegExp, commands: string[]) {
  for (const command of commands) {
    it(`denies ${JSON.stringify(command)}`, () => {
      const got = bashDenyReason(command, project);
      assert.ok(got !== null, "expected a deny");
      assert.match(got, reason);
    });
  }
}

function allows(commands: string[]) {
  for (const command of commands) {
    it(`allows ${JSON.stringify(command)}`, () => {
      const got = bashDenyReason(command, project);
      assert.equal(got, null, got ?? "");
    });
  }
}

const SAFETY = (why: string) =>
  new RegExp(`Blocked by the team's safety policy \\(${why}\\)`);
const ANY_SAFETY = /Blocked by the team's safety policy/;
const SECRET = /reads secrets or the process environment/;

describe("a substitution inside a message value is screened", () => {
  denies(ANY_SAFETY, [
    `git commit -m "$(sh -cm 'rm -rf src')"`,
    `git commit -m 'x' -m "$(sh -cm 'rm -rf src')"`,
    `git commit -m "$(sh -cm 'git reset --hard HEAD~3')"`,
    `git commit -m "$(bash -cm 'git push --force origin main')"`,
  ]);
  denies(SECRET, [`git commit -m "$(bash -cm 'cat .env')"`]);
});

describe("quotes that straddle separators do not hide a command", () => {
  denies(SAFETY("recursive delete"), [
    `git commit -m x " -m '" ; rm -rf src ; echo "'"`,
    `git commit -m x "a -m '" && rm -rf src && echo "'"`,
  ]);
  denies(SECRET, [`git commit -m x " -m '"; cat .env; echo "'"`]);
});

describe("only Claude Code's exact commit heredoc has its body stripped", () => {
  allows([
    "git commit -m \"$(cat <<'EOF'\nfix: ignore .env files\n\ngit reset --hard is blocked\nEOF\n)\"",
    "git commit -a -m \"$(cat <<'EOF'\nfix: stop rm -rf in cleanup\nEOF\n)\"",
    "git commit -m \"$(cat <<-'EOF'\n\tfix: stop rm -rf in cleanup\n\tEOF\n)\"",
  ]);
  denies(SAFETY("recursive delete"), [
    "git commit -m \"$(cat <<'EOF'\nx\nEOF\nrm -rf src\nEOF\n)\"",
    "git commit -m \"$(cat <<-'EOF'\nx\n\tEOF\nrm -rf src\n\tEOF\n)\"",
    // A double-quoted delimiter is not the exact form.
    'git commit -m "$(cat <<"EOF"\nfix: stop rm -rf in cleanup\nEOF\n)"',
    // Nor is an unquoted one, which expands its body.
    'git commit -m "$(cat <<EOF\n$(rm -rf src)\nEOF\n)"',
  ]);
  denies(SECRET, ["git commit -m \"$(cat <<'EOF'\nx\nEOF\ncat .env\nEOF\n)\""]);
});

describe("a shell or eval given a computed script is refused", () => {
  denies(ANY_SAFETY, [
    `git commit -m 'rm -rf src' && bash -c "true; $(git log -1 --format=%s)"`,
    `git commit -m 'rm -rf src' && eval "true; $(git log -1 --format=%s)"`,
    `git commit -m 'rm -rf src' && sh -c -- "$(git log -1 --format=%s)"`,
  ]);
  denies(SAFETY("hides the command it runs"), [
    `git commit -m 'x' && bash -c "true; $(git log -1 --format=%s)"`,
    `git commit -m 'x' && eval "true; $(git log -1 --format=%s)"`,
    `git commit -m 'x' && sh -c -- "$(git log -1 --format=%s)"`,
    `bash --norc -c "$(git log -1 --format=%s)"`,
    "bash -c 'echo `id`'",
    "bash <(git log -1 --format=%s)",
    "source <(git log -1 --format=%s)",
    ". <(git log -1 --format=%s)",
    "git log -1 --format=%s | sh",
    "git show -s --format=%B HEAD | bash",
  ]);
  allows([
    'bash -c "pnpm test"',
    "sh -c 'pnpm lint && pnpm test'",
    "source ./env.sh",
  ]);
});

describe("a message in a subshell or group is screened whole (accepted trade-off)", () => {
  denies(ANY_SAFETY, [
    "(git commit -m 'rm -rf src')",
    "(cd sub && git commit -m 'fix: rm -rf build dir')",
    "{ git add -A; git commit -m 'docs: why git reset --hard is blocked'; }",
    "git add -A && git commit -m 'fix: rm -rf build dir'",
  ]);
});

describe("top-level literal messages are text", () => {
  allows([
    "git commit -m 'fix: rm -rf build dir'",
    'git commit -m "fix: rm -rf build dir"',
    "git commit -am 'chore: never git push --force'",
    "git commit -m 'x' -m 'body: git reset --hard is blocked'",
    "git commit --message='docs: rm -rf is refused'",
    "git commit -m '$(rm -rf src)'",
    "git commit -m 'docs: the `cat .env` trick is blocked'",
    "git commit -F msg.txt",
    "git -C sub commit -m 'chore: drop .env from repo'",
    "git tag -a v1 -m 'rm -rf is blocked now'",
    "git notes add -m 'git push --force is refused'",
    "git stash push -m 'wip: before git reset --hard'",
    "gh pr create -t 'drop git clean -fd' -b 'printenv was removed'",
    "gh issue create --title 'rm -rf in setup.sh' --body 'see git reset --hard'",
    "gh pr comment 4 --body 'the hook blocks rm -rf ~'",
  ]);
  denies(SAFETY("recursive delete"), [
    // A double-quoted value that can expand is not literal.
    'git commit -m "fix: \\$x rm -rf build"',
    "git commit -m 'x' # ; rm -rf src",
    "git -C 'sub' commit -m 'x' && rm -rf src",
  ]);
});

describe("git rm reads --cached the way git does, after dequoting", () => {
  allows([
    "git rm -r src '--cached'",
    "git rm -r src '#' --cached",
    'git rm -r "--cached" dist',
    "git rm -r --cached dist",
  ]);
  denies(SAFETY("recursive delete"), [
    "git rm -r src #--cached",
    "git rm -r -- src --cached",
    "git rm -r src -- --cached",
    "git rm -r src '--' --cached",
  ]);
});
