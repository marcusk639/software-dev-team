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
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import {
  approvalReason,
  createPolicy,
  createSafetyHooks,
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
      approvalReason(policy, "Read", { file_path: "links/etclink/hosts" }) ??
        "",
      OUTSIDE,
    );
    assert.match(
      approvalReason(policy, "Glob", { pattern: "links/etclink/*" }) ?? "",
      OUTSIDE,
    );
  });
});

describe("I3 (withdrawn in round 4): messages are screened like any other text", () => {
  // The allow cases that named a blocked command moved to
  // permissions-message-false-positives.test.ts as pinned denies.
  allows([bash('gh pr edit 4 --body "explains git config alias.x"')]);
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
    [
      "Agent",
      { subagent_type: "qa-tester", prompt: "p", isolation: "worktree" },
    ],
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

describe("malformed tool input is denied, not read as empty", () => {
  denies(/must be a string/, [
    ["Bash", { command: ["rm", "-rf", "src"] }],
    ["Bash", {}],
    ["Write", { file_path: 1, content: "x" }],
    ["Edit", { old_string: "a", new_string: "b" }],
    ["NotebookEdit", { notebook_path: null, new_source: "x" }],
  ]);
  allows([["Write", { file_path: "src/b.ts", content: "x" }]]);

  it("denies a hook call whose tool_input is not an object", async () => {
    const hooks = createSafetyHooks(policy);
    for (const tool_input of [null, "rm -rf src", ["x"]]) {
      const out = (await hooks.PreToolUse[0]!.hooks[0]!(
        {
          hook_event_name: "PreToolUse",
          session_id: "s",
          transcript_path: "/t",
          cwd: project,
          tool_name: "Bash",
          tool_input,
          tool_use_id: "t1",
          agent_type: "qa-tester",
          agent_id: "a1",
        } as HookInput,
        "t1",
        { signal: new AbortController().signal },
      )) as {
        hookSpecificOutput?: {
          permissionDecision?: string;
          permissionDecisionReason?: string;
        };
      };
      assert.equal(
        out.hookSpecificOutput?.permissionDecision,
        "deny",
        String(tool_input),
      );
      assert.match(
        out.hookSpecificOutput?.permissionDecisionReason ?? "",
        /not an object/,
      );
    }
  });
});

describe("a word that cannot be checked denies instead of passing", () => {
  const locked = join(project, "locked");
  mkdirSync(locked, { mode: 0o000 });
  it("denies a command naming a file it cannot lstat (EACCES)", async () => {
    assert.throws(
      () => denyReason(policy, "Bash", { command: "cat locked/config" }),
      /EACCES/,
    );
    // The hook turns the throw into a deny.
    const out = (await createSafetyHooks(policy).PreToolUse[0]!.hooks[0]!(
      {
        hook_event_name: "PreToolUse",
        session_id: "s",
        transcript_path: "/t",
        cwd: project,
        tool_name: "Bash",
        tool_input: { command: "cat locked/config" },
        tool_use_id: "t1",
        agent_type: "qa-tester",
        agent_id: "a1",
      } as HookInput,
      "t1",
      { signal: new AbortController().signal },
    )) as {
      hookSpecificOutput?: {
        permissionDecision?: string;
        permissionDecisionReason?: string;
      };
    };
    assert.equal(out.hookSpecificOutput?.permissionDecision, "deny");
    assert.match(
      out.hookSpecificOutput?.permissionDecisionReason ?? "",
      /could not evaluate this call \(EACCES/,
    );
  });
  allows([bash(`echo ${"x".repeat(5000)}`), bash("cat missing/file.txt")]);
});

describe("the policy's agent lists cannot be changed after it is built", () => {
  it("refuses to add to agents or pinnedModels", () => {
    assert.throws(
      () => (policy.agents as Set<string>).add("intruder"),
      /read-only/,
    );
    assert.throws(
      () => (policy.pinnedModels as Set<string>).delete("x"),
      /read-only/,
    );
    assert.equal(policy.agents.has("intruder"), false);
  });
});

describe("jq's env builtin prints the environment", () => {
  denies(ENV_OR_SECRET, [
    bash("jq -n env"),
    bash("jq -n '$ENV'"),
    bash("jq -n 'env.ANTHROPIC_API_KEY'"),
    bash("echo {} | jq 'env | keys'"),
  ]);
  allows([
    bash("jq .version package.json"),
    bash("jq '.scripts.test' package.json"),
  ]);
});

describe("re-review 1: a nested shell's -cm is not a message", () => {
  denies(SAFETY("recursive delete"), [
    bash("git commit $(sh -cm 'rm -rf src')"),
    bash("git commit `sh -cm 'rm -rf src'`"),
    bash("git commit -F <(sh -cm 'rm -rf src')"),
    bash("git commit -m '$(rm -rf src)' $(sh -cm 'rm -rf src')"),
  ]);
  denies(/reads secrets or the process environment/, [
    bash("git commit $(bash -cm 'cat .env')"),
    bash("git tag v1 $(sh -cm 'env')"),
  ]);
  denies(SAFETY("hides the command it runs"), [
    // The message is no longer stripped here (`&&`), so its own rm is seen
    // first; the computed script is pinned without it.
    bash(`git commit -m 'x' && bash -c "$(git log -1 --format=%s)"`),
    bash("sh -c `git log -1 --format=%s`"),
    bash('eval "$(git log -1 --format=%s)"'),
  ]);
  allows([bash('bash -c "pnpm test"')]);
});

describe("re-review 2: --cached counts only as an option, before -- and outside a comment", () => {
  denies(SAFETY("recursive delete"), [
    bash("git rm -r src #--cached"),
    bash("git rm -r -- src --cached"),
    bash("git rm -r src -- --cached"),
  ]);
  allows([
    bash("git rm -r --cached dist"),
    bash("git rm -r --cached -- dist"),
    bash("git rm -r dist --cached"),
  ]);
});

describe("re-review 4: ~ is the home directory for every read tool", () => {
  needsApproval([
    ["Read", { file_path: "~/notes.txt" }],
    ["Read", { file_path: "~" }],
    ["Grep", { pattern: "x", path: "~/projects" }],
    ["Glob", { pattern: "*", path: "~" }],
  ]);
  denies(/outside the project is not permitted/, [
    ["Grep", { pattern: "x", path: "~/projects", output_mode: "content" }],
  ]);
});

describe("re-review 1: single-quoted message text is literal, unless the quotes are themselves inside a string", () => {
  allows([]);
  denies(SAFETY("recursive delete"), [
    bash(`bash -c "git commit -m '$(rm -rf src)'"`),
    bash(`sh -c "git commit -m '\`rm -rf src\`'"`),
  ]);
});
