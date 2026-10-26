/**
 * Round 4 ruling: commit and PR messages are no longer stripped before the
 * checks (review finding I3 withdrawn). A message that names a blocked
 * command or a protected file is screened like any other text, so these
 * are denied. This is the accepted false positive; the workaround is to
 * write the message to a file and use `git commit -F <file>`.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { bashDenyReason } from "./permissions.js";

const project = realpathSync(mkdtempSync(join(tmpdir(), "sdt-msgfp-")));
mkdirSync(join(project, "src"));
writeFileSync(join(project, ".env"), "KEY=x\n");
writeFileSync(join(project, "msg.txt"), "fix: stop rm -rf in cleanup\n");

const REASON =
  /Blocked by the team.s safety policy|reads secrets or the process environment|may write to git internals or agent configuration/;

const ACCEPTED_FALSE_POSITIVES = [
  "git commit -m \"docs: update CLAUDE.md\"",
  "git commit -m \"$(cat <<'EOF'\nfix: ignore .env files\n\ngit reset --hard is blocked\nEOF\n)\"",
  "git commit -a -m \"$(cat <<'EOF'\nfix: stop rm -rf in cleanup\nEOF\n)\"",
  "git commit -m \"$(cat <<-'EOF'\n\tfix: stop rm -rf in cleanup\n\tEOF\n)\"",
  "git commit -m 'fix: rm -rf build dir'",
  "git commit -m \"fix: rm -rf build dir\"",
  "git commit -am 'chore: never git push --force'",
  "git commit -m 'x' -m 'body: git reset --hard is blocked'",
  "git commit --message='docs: rm -rf is refused'",
  "git commit -m '$(rm -rf src)'",
  "git commit -m 'docs: the `cat .env` trick is blocked'",
  "git -C sub commit -m 'chore: drop .env from repo'",
  "git tag -a v1 -m 'rm -rf is blocked now'",
  "git notes add -m 'git push --force is refused'",
  "git stash push -m 'wip: before git reset --hard'",
  "gh pr create -t 'drop git clean -fd' -b 'printenv was removed'",
  "gh issue create --title 'rm -rf in setup.sh' --body 'see git reset --hard'",
  "gh pr comment 4 --body 'the hook blocks rm -rf ~'",
  "git commit -am 'docs: tweak CLAUDE.md'",
  "git commit -sm \"fix: .env loading order\"",
  "git commit -asm 'chore: ignore .claude/local'",
  "git commit -m \"docs: explain why git reset --hard is blocked\"",
  "git commit -m \"fix: stop rm -rf in cleanup script\"",
  "gh pr create --title x --body \"never run git push --force\"",
  "gh pr create -t \"drop git clean -fd\" -b \"printenv was removed\"",
  "gh issue create --title \"rm -rf in setup.sh\" --body \"see git reset --hard\"",
  "gh pr comment 4 --body \"the hook blocks rm -rf ~\"",
  "git tag -a v1 -m \"rm -rf is blocked now\"",
  "git notes add -m \"git push --force is refused\"",
  "gh pr create --title \"x\" --body \"gh repo delete is blocked\"",
  "git commit -m 'docs: why $(rm -rf src) is refused'",
  "git commit -m \"docs: describe .claude/dev-team prompts\"",
  "git commit -m 'fix: ignore .git dir in walker'",
  "gh pr create --title \"Handle .mcp.json\" --body \"touches .mcp.json handling\"",
  "git commit -m \"chore: add .env to .gitignore\"",
];

describe("accepted false positive (round 4): a message naming a blocked command or protected file is denied; use git commit -F <file>", () => {
  for (const command of ACCEPTED_FALSE_POSITIVES) {
    it(`denies ${JSON.stringify(command)} (accepted false positive)`, () => {
      assert.match(bashDenyReason(command, project) ?? "", REASON);
    });
  }

  it("leaves the workaround open: git commit -F <file>", () => {
    assert.equal(bashDenyReason("git commit -F msg.txt", project), null);
    assert.equal(bashDenyReason("git commit -m 'fix: tidy cleanup script'", project), null);
  });
});
