# Security: model and known limits

**Last reviewed:** 2026-11-11, by a security review of the allow rules and the PR reviewer's advisories on #13. **Scope:** the harness in `src/`, the image, the `--publish` step and the GitHub workflows. **Audience:** whoever deploys the team or changes its safety layer.

This page lists what protects a run and every known way around it, so a deployment decision is made with the gaps in view. [deployment.md](deployment.md) covers how to deploy; this page covers what that deployment still exposes. When you find a new gap, add it to the register below, even if it is fixed in the same change.

## 1. Treat the team as untrusted code

The team reads the target repository, its issues and the task text, and any of that can carry instructions (prompt injection). So assume an agent will try anything its tools allow, and judge each layer by what it stops, not by what the prompts ask:

| Layer                    | Stops                                                                                                                                                                                                                                                                                                  | Where                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Safety hook (PreToolUse) | Destructive commands, deploys, pushes and PR changes, commands that print secrets or the environment, file-tool writes outside the project or to protected paths. Reads outside the project with Read, Grep and Glob need approval, which an unattended run never gets. Runs in every permission mode, in subagents too, and no allow rule overrides it. | `src/permissions.ts`, `src/permissions/*`            |
| Permission rules         | Under `--yes`, any tool call that neither `acceptEdits` nor an allow rule approves is refused. This is the guard for everything the hook only screens by text (most Bash).                                                                                                                             | `src/allowlist.ts`, profile `allow` lists, `--allow` |
| Role guards              | The manager can only delegate; specialists can't delegate; only qa-tester can edit the acceptance tests it wrote (file tools).                                                                                                                                                                         | `src/permissions.ts`, `src/test-authorship.ts`       |
| The container            | No credentials but the model key, no network beyond the API, read-only root, all capabilities dropped, non-root user, only `/workspace` mounted. This is the boundary for code the team writes and then runs.                                                                                          | `Dockerfile`, [deployment.md §2–5](deployment.md)    |
| The publish step         | Runs outside the run, with no model; commits and pushes only a `done` run, to a review branch, never forced, never secret files; hooks run without the token.                                                                                                                                          | `src/publish.ts`, [deployment.md §6](deployment.md)  |
| Human review             | A person reads `changed_files` before merging, including any `package.json`, test config or workflow change.                                                                                                                                                                                           | your process                                         |

The shell rules match command text. They are a second line, not a sandbox: anything an allow rule approves, and anything a team-written script does once an approved command runs it, is bounded only by the container.

## 2. Register

Status: **fixed** (closed, with its test), **mitigated** (narrowed, residual risk accepted), **open** (known and not yet addressed), **accepted** (by design).

| #   | Issue                                                                                 | Severity | Status                 |
| --- | ------------------------------------------------------------------------------------- | -------- | ---------------------- |
| S1  | Pre-approved `git diff` read any file outside the project                             | High     | fixed                  |
| S2  | Bash reads are confined only by approval and a name-based secret list                 | Medium   | mitigated              |
| S3  | Output redirects from approved commands can write outside the project                 | Low      | open                   |
| S4  | Approved commands run code the team writes                                            | Medium   | accepted, mitigated    |
| S5  | `--allow` accepts rules that approve almost anything                                  | Medium   | open, accepted for now |
| S6  | The target repository's `.claude` settings, hooks and MCP servers load into every run | Medium   | accepted               |
| S7  | The acceptance-test lock covers file tools and test-named files only                  | Low      | accepted               |
| S8  | The push token reached the repository's hooks during `--publish`                      | High     | fixed                  |
| S9  | The model credential is readable by code the run executes                             | Medium   | accepted, mitigated    |
| S10 | Shell rules are pattern-based and have been bypassed before                           | Medium   | mitigated              |
| S11 | Harness behaviour rests on SDK details verified against one version                   | Low      | open                   |
| S12 | GitHub workflows run with secrets on comments and PRs                                 | Low      | mitigated              |

### S1. Pre-approved `git diff` read any file outside the project (fixed)

The recovery-platform profile pre-approves `Bash(git diff:*)`. `git diff --no-index /etc/passwd /dev/null` printed any file with no approval, and inside a repository `git diff /etc/hosts /dev/null` switches to `--no-index` without being asked. That reached files the secret list misses (S2).

**Fix:** `gitReadsOutside` in `src/permissions/shell.ts` refuses `git diff` and `git grep` with `--no-index` or any abbreviation git accepts (`--no-in`…), `git diff` with a path operand outside the project, and either one run from outside it through `-C`, `--git-dir`, `--work-tree`, or env's chdir option in any spelling (`-C/`, `-iC/`, `--chd=`).

A directory change anywhere in the command makes `git diff` and `git grep` count as reading outside, because the hook can't know where git then runs: a `cd` may fail, run in a subshell, sit behind `||`, or hide in an alias, `coproc` or `bash -c`. That covers `cd`, `pushd`, `popd` and `chdir` as words, and any mention of `CDPATH`, `GIT_DIR`, `GIT_WORK_TREE` or `GIT_COMMON_DIR`: a mention rather than `NAME=`, since `NAME+=`, `read NAME`, `printf -v NAME` and `declare` set them too. A variable whose name is built by expansion (`export ${x}_TREE=/`, in an assignment builtin, `read`, `printf -v` or `env`) is refused outright, as is `set -a` / `set -o allexport`, which exports whatever a sourced file sets. The git-environment rule ("changes what git runs": `GIT_CONFIG_*`, `GIT_EXEC_PATH`, `GIT_SSH_COMMAND`, `GIT_EXTERNAL_DIFF`…) sees the same spellings. Earlier rounds tried to follow where each `cd` lands, and the reviewer found a new spelling each time. The cost is small: `cd src && git diff a.ts` `git grep cd` and `git grep GIT_DIR` are refused too, and the refusal says to run git diff on its own, from the project root.

**Residual:** other launchers that change directory (`sudo -D`, `nsenter --wd`, `chroot`) aren't parsed. In the image, `sudo` isn't installed, and `chroot` and `nsenter` need privileges the container doesn't have: it runs as a non-root user with `--cap-drop ALL` and `no-new-privileges`. An unattended run doesn't pre-approve any of them either.

The abbreviation, directory-change and spelling cases came from the PR reviewer's private advisories on #13. Tests: `src/permissions-release.test.ts`, "security review" suites.

### S2. Bash reads are confined only by approval and a name-based secret list (mitigated)

Read, Grep and Glob need approval for paths outside the project, so an unattended run can't use them there. Bash is different: the hook lets `cat /etc/passwd` through and relies on the permission rules, which refuse an unapproved command under `--yes` and ask in an interactive run. So any allow rule for a command that reads files is a read outside the project unless the hook confines that command (S1 did this for `git diff`/`git grep`).

The hook also refuses commands that name a secret, by name: `.env*`, keys, `~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/.claude/.credentials.json`, `.git-credentials`, `.npmrc` and similar (`SECRET_PATH` in `src/permissions/paths.ts`). It misses, among others, `~/.config/configstore/firebase-tools.json` (firebase-tools' login), shell history and `/run/secrets/*`.

**Mitigation:** the container has none of those files with anything in them (no Firebase login, no shell history worth reading, no mounted secrets). **Rule for changes:** before adding an allow rule for a command that reads, check the hook confines it, or add a confinement like S1's.

### S3. Output redirects from approved commands can write outside the project (open, low priority)

The hook checks redirect targets only against protected paths (`git log > .husky/pre-commit` is refused). `git log > /tmp/x` passes the hook. Whether the SDK's prefix rule `Bash(git log:*)` approves a command with a redirect is not verified. If it does, an approved command can write anywhere the user can.

**Why low:** in the container the root filesystem is read-only and writable places are tmpfs mounts and `/workspace`, so a stray write is lost with the container or shows up in `changed_files`. **Fix when needed:** refuse redirect, `tee` and `-o` targets that resolve outside the project, next to the protected-path check.

### S4. Approved commands run code the team writes (accepted, mitigated)

`npm --prefix <pkg> test`, `firebase emulators:exec … "npm --prefix <pkg> run …"` and the other test commands run the package's scripts, its Jest config and the tests themselves, all of which the team may edit. That code can do anything the process can: open sockets, read the environment, run `git push`. The hook never sees it. This is inherent in letting the team run its tests.

**Mitigation:**

- The container is the boundary: no credentials but the model key (S9), no network beyond the API.
- npm can't be pointed at other code: the hook refuses `--script-shell`, `--userconfig`, `--globalconfig`, a second `--prefix` or `-C`, `--node-options` (which sets `NODE_OPTIONS` for the scripts, so `--require=<file>` loads any code) and `NODE_OPTIONS` in a command that, anywhere, names a module loader (`--require`, `-r`, `--import`, `--loader`) or sets `NODE_OPTIONS` from a variable (`--max-old-space-size` and the like stay allowed), any abbreviation npm accepts (`--scr`, `--nod`, `--userc`, `--prefi`), and the matching `npm_config_*` variables (`NPM_CONFIG_OVERRIDES` in `src/permissions/shell.ts`). `.npmrc` is a secret path, so the team can't write it either.
- A person reviews `changed_files` before merging, so a change to `package.json` scripts or a test config is visible.

### S5. `--allow` accepts rules that approve almost anything (open, accepted for now)

`src/allowlist.ts` checks a rule's syntax and refuses wildcard-only roots, but accepts:

- shell and interpreter launchers as prefix rules: `Bash(bash:*)`, `Bash(sh -c:*)`, `Bash(node:*)`, `Bash(npx:*)`, `Bash(env:*)`, `Bash(curl:*)`, `Bash(git:*)`;
- bare `WebFetch` or `WebFetch(domain:…)`, a whole MCP server (`mcp__github`), and bare `Task`, `Agent` or `Skill`;
- reads anywhere (`Read(//etc/**)`), by design.

The hook still refuses what it refuses, so `Bash(bash:*)` doesn't unlock `git push`. But it does approve everything the hook only screens by text (S2, S10). Write rules outside the project (`Edit(//etc/**)`) are accepted but harmless: the hook refuses file-tool writes outside the project whatever the rules say.

**For now:** `--allow` is the operator's own decision, so a broad rule is the operator's risk. Keep job definitions to the profile's rules plus narrow, exact additions. **Fix when needed:** refuse launcher prefixes (`bash`, `sh`, `zsh`, `node`, `python`, `npx`, `pnpx`, `env`, `xargs`, `sudo`, `curl`, `wget`) and warn on bare `WebFetch`, MCP-server and agent rules.

### S6. The target repository's `.claude` settings, hooks and MCP servers load into every run (accepted)

The run loads the target's `.claude` tree (`settingSources: ["project"]`), which it needs for the target's CLAUDE.md files and agents. That also loads the target's `settings.json` hooks and `.mcp.json` servers, which run as the target's code with the run's access. The target's `permissions.allow` rules load too, but can't weaken the safety hook: a PreToolUse deny wins (verified against a target declaring `allow: ["Bash"]`).

**So:** `--cwd` is a trust boundary. Point it only at repositories you trust, and review changes to the target's `.claude/` and `.mcp.json` like code. The team itself can't write `.claude/` or `.mcp.json` (protected paths).

### S7. The acceptance-test lock covers file tools and test-named files only (accepted)

Once qa-tester writes a test, other roles' Write and Edit calls to it are refused. A shell write (`sed -i`, a redirect) isn't tracked, and only files named as tests are locked (`isTestPath` in `src/test-authorship.ts`). This lock protects the evidence, not the system: the manager is told a green run reached by a shell edit is unverified, and recovery-platform's commit gate (`.claude/agent-gates/verify-diff.sh`) rejects weakened tests at publish time.

### S8. The push token reached the repository's hooks during `--publish` (fixed)

The commit ran with `GITHUB_TOKEN` in its environment, and `git push` ran the repository's pre-push hook with the token in git's environment. Recovery-platform's pre-push runs each changed package's `npm test`, which is code the team wrote, with network access to GitHub. Any token git can push with is readable by the hooks `git push` runs.

**Fix** (`src/publish.ts`):

- Every git call the step makes runs without `GITHUB_TOKEN`, `GH_TOKEN` or any variable holding the token. The branch switch, add and reset can run hooks too (`reference-transaction`, `post-checkout`), not only the commit.
- The step runs pre-push itself, with the arguments and stdin `git push` would give it (`git hook run --to-stdin`).
- Only then does it push, the one process that has the token, with no hooks at all: `--no-verify` skips pre-push, and `core.hooksPath=/dev/null` skips the `reference-transaction` hook that updating the remote-tracking ref would run.

Tests: `src/publish.test.ts`, "publish keeps the push token from the repository's hooks".

### S9. The model credential is readable by code the run executes (accepted, mitigated)

`ANTHROPIC_API_KEY` is in the run's environment, and a test the team writes can read it (S4). The hook refuses shell commands that print the environment, not test code. **Mitigation:** use a dedicated workspace key with a spend limit, or run an egress proxy that injects the credential so the container holds only a placeholder ([deployment.md §3](deployment.md)). Use an API key, not a subscription token, for the unattended team.

### S10. Shell rules are pattern-based and have been bypassed before (mitigated)

Each review round of the safety layer (PRs #2–#5, #8) found spellings that slipped past a rule: quoting, wrappers (`env`, `npx`, `node <bin>`), separators, git global options, abbreviations. The rules now check several spellings of each command (`spellings()`, `normalizeGit`, `expandLongOptions`), and every fixed bypass is pinned as a test. Expect more: PR #13 alone took six review rounds, each finding a new spelling (abbreviations, `cd` in its many forms, `+=`, `read`, `printf -v`, computed names). Matching text can't keep up with everything a shell can express. Whether any of these is reachable in an unattended run depends on how the SDK matches a prefix rule against a compound command, an assignment or a wrapper (S11): if `Bash(git diff:*)` doesn't approve `cd / && git diff …`, the spellings only matter for interactive approvals. Verifying that is worth more than another round of patterns. **So:** the container, not the hook, is what must hold if a rule is bypassed, and a new deny rule needs tests for abbreviations, wrappers and compound commands, as S1 and S4 have.

### S11. Harness behaviour rests on SDK details verified against one version (open)

Some guarantees depend on SDK behaviour checked against 0.3.283 only:

- a hook deny overriding allow rules;
- the built-in agents being disabled through `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS`, which is undocumented;
- how prefix rules treat compound commands and redirects (S3).

0.3.322 is current. **Before upgrading:** do the supervised live trial and the upgrade checks in [the readiness review](reviews/2026-11-10-standalone-readiness.md) §6. Those include re-verifying the undocumented variable and the pinned hook-ordering test, the one against a target that declares `allow: ["Bash"]`.

### S12. GitHub workflows run with secrets on comments and PRs (mitigated)

`claude.yml` runs Claude with the repository's model token when an owner, member or collaborator writes `@claude`. It skips PRs from forks (including deleted forks) and agent-authored branches (`hco/*`, `e2e-fix/*`), installs with `--ignore-scripts`, pins every action by SHA, and pre-approves only this repo's test and typecheck commands for Bash. `pr-review.yml` runs on same-repo PRs to `main` only.

Security-relevant review findings go to private draft advisories under the Security tab, never into PR comments. That needs both `PR_REVIEW_ID_KEY` and `SECURITY_ADVISORY_TOKEN`; without them the reviewer drops security findings, which is how S1 was first lost.

## 3. Checklist for a change to the safety layer or an allow rule

- Does the new allow rule approve a command that reads or writes outside the project? Then confine it in the hook first (S1, S2, S3).
- Does the rule's prefix let options through that change what runs, or where? Check the tool's aliases and abbreviations (S1, S4).
- Is there a test for each spelling: an abbreviation, a wrapper, a compound command, a directory change?
- Does anything that runs the repository's code also hold a credential (S8, S9)?
- Update this register.
