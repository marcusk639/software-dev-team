/**
 * Commit and PR messages are screened in full (round 4 ruling: message
 * stripping removed). These pin the inputs that earlier stripping rounds let
 * through, and the computed-script and git rm rules found on the way.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { bashDenyReason } from "./permissions.js";

const project = realpathSync(mkdtempSync(join(tmpdir(), "sdt-messages-")));
mkdirSync(join(project, "src"));
writeFileSync(join(project, ".env"), "KEY=x\n");

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

describe("a commit heredoc is screened, body included", () => {
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

describe("a message in a subshell or group is screened (accepted false positive)", () => {
  denies(ANY_SAFETY, [
    "(git commit -m 'rm -rf src')",
    "(cd sub && git commit -m 'fix: rm -rf build dir')",
    "{ git add -A; git commit -m 'docs: why git reset --hard is blocked'; }",
    "git add -A && git commit -m 'fix: rm -rf build dir'",
  ]);
});

describe("message flags hide nothing", () => {
  allows(["git commit -F msg.txt"]);
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

describe("round 4: the earlier stripping regressions stay denied", () => {
  denies(SAFETY("recursive delete"), [
    "git commit -m \"$(cat <<'EOF'\nbody\\\nEOF\nrm -rf src\nEOF\n)\"",
    "git commit -m \"$(cat <<-'EOF'\n\tbody\\\n\tEOF\nrm -rf src\n\tEOF\n)\"",
  ]);
  denies(SECRET, [
    "git commit -m \"$(cat <<'EOF'\nbody\\\nEOF\ncat .env\nEOF\n)\"",
    "git commit -Fm'/../.env'",
    "git commit -Fm'obile/../.env'",
    "git tag -a v1 -Fm'/../.env'",
    "git notes add -Fm'/../.env'",
    "git commit -tm'/../.env'",
    "git commit -Fm/../.env",
  ]);
});

describe("round 4: a clustered -F or -t value is a path", () => {
  it("denies -F naming a symlink to a secret", () => {
    const link = join(project, "src", "msg");
    symlinkSync("../.env", link);
    assert.match(bashDenyReason("git commit -Fsrc/msg", project) ?? "", SECRET);
    assert.match(bashDenyReason("git commit -Fmsrc/../src/msg", project) ?? "", SECRET);
  });
  allows(["git commit -Fmsg.txt", "git commit -tmpl.txt"]);
});

describe("round 4: computed scripts, whatever the options or redirections", () => {
  denies(SAFETY("hides the command it runs"), [
    `bash -o posix -c "$(git log -1 --format=%s)"`,
    `bash -O extglob -c "$(git log -1 --format=%s)"`,
    `bash --rcfile x -c "$(git log -1 --format=%s)"`,
    `bash --init-file x -c "true; $(git log -1 --format=%s)"`,
    "sh < <(git log -1 --format=%s)",
    "bash 0< <(git log -1 --format=%s)",
    `bash <<< "$(git log -1 --format=%s)"`,
    `bash -s <<< "$(git log -1 --format=%s)"`,
    "bash <<< `git log -1 --format=%s`",
    "git log -1 --format=%s | sudo sh",
    "git log -1 --format=%s | env bash",
    "git log -1 --format=%s | doas sh",
    "$(git log -1 --format=%s)",
    "`git log -1 --format=%s`",
    "true && $(git log -1 --format=%s)",
    "echo hi; `git log -1 --format=%s`",
  ]);
  allows([
    "x=$(date) && echo $x",
    "echo $(pwd)",
    "bash -o pipefail -c 'pnpm test'",
    "bash <<< 'echo hi'",
    "echo $((1 + 2))",
    "$(npm bin)/tsc --noEmit",
  ]);
});

describe("round 4: git stash pathspecs are screened after option parsing", () => {
  denies(/may write to git internals or agent configuration/, [
    "git stash push -m -m '.claude/settings.json'",
    "git stash push -- -m '.claude/settings.json'",
  ]);
  denies(SECRET, ["git stash push -u -m -m '.env'"]);
});

describe("round 4: eval is judged only in command position, outside quotes", () => {
  allows([
    "echo 'never use eval' && x=$(date)",
    "grep -r 'eval' src | head -5 && echo $(pwd)",
    'echo "eval is blocked" && echo `pwd`',
  ]);
  denies(SAFETY("hides the command it runs"), [
    'eval "true; $(git log -1 --format=%s)"',
    "x=1; eval `git log -1 --format=%s`",
    "eval echo $(id)",
  ]);
});
