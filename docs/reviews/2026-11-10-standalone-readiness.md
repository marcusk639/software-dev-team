# Standalone readiness review: software-dev-team under Hermes, in Docker, on recovery-platform

- **Date:** 2026-11-10
- **Branch:** `review/standalone-readiness`, stacked on PR #7 (`claude/determined-carson-elxohv` at `69531b4`), the branch with the project profiles
- **Goal reviewed against:** the team runs unattended, as a worker that Hermes Agent starts in a Docker container on a cloud server, and builds features in `~/dev/recovery-platform` test-first, with end-to-end tests and code that works and follows the repository's patterns.

Contents:

1. [Verdict](#1-verdict)
2. [Method](#2-method)
3. [Findings and changes](#3-findings-and-changes)
4. [Independent review of this change](#4-independent-review-of-this-change)
5. [Verification evidence](#5-verification-evidence)
6. [Recommended next steps (not done here)](#6-recommended-next-steps-not-done-here)
7. [Residual risks](#7-residual-risks)

## 1. Verdict

**Before this change, the team could not do the job unattended.** An unattended run (`--yes`) approved no test command, so qa-tester and the engineers could not verify anything. Nothing asked for test-first development. The run printed human-readable text, which no orchestrator could parse. The recovery-platform profiles gave root-relative paths, yet were selected only when `--cwd` was a product directory, where those paths don't resolve. Nothing stopped a plain `git push`, `firebase deploy` or `gh pr merge`. There was no container image.

**After it, the harness is ready for a supervised trial**, with one gap. No live run against recovery-platform with an API key has been done, because it costs money and needs a key; that trial is the first next step (§6). Everything below that can be checked without spending tokens was checked: unit tests, a real CLI spawn, the image build, a hardened container run, and the Firestore emulator offline inside it.

The ten changes, in priority order:

| #   | Area                    | Change                                                                                                                                                                                        |
| --- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Orchestrator contract   | `--output json`: one result object on stdout, compatible with `claude -p --output-format json`, plus the team's outcome, question, commit message, changed files, acceptance tests and ledger |
| 2   | Unattended verification | Profiles carry `allow` rules for the project's exact test, typecheck, build and emulator commands, and the profile text tells agents to use exactly those forms                               |
| 3   | Test-first              | A test-first stage in the manager's workflow, a qa-tester test-first mode, TDD rules in the shared conventions, red-then-green evidence, and reviewer checks on the tests                     |
| 4   | Test integrity          | Files qa-tester writes become read-only to other roles' file tools, matched by inode and path                                                                                                 |
| 5   | Shipping                | Deploys, pushes, PR changes, releases, cloud builds and CI dispatch are hard-denied, however they are launched                                                                                |
| 6   | Escape paths            | The team can't write CI workflows or git hooks, and git's read commands can't write files                                                                                                     |
| 7   | Profile root            | Profiles with root-relative paths require `--cwd` at the root, with an actionable error otherwise                                                                                             |
| 8   | Container               | A Dockerfile (Node 22, Java 21, pinned firebase-tools with emulators pre-fetched, non-root, root-owned harness), verified under hardened flags                                                |
| 9   | Operations              | [docs/deployment.md](../deployment.md): credentials policy, job preparation, run flags, result contract, commit procedure, Hermes integration                                                 |
| 10  | Correctness             | A failed run never reports `subtype: success`; approval prompts moved to stderr                                                                                                               |

Test count went from 1,226 on main (1,250 on PR #7) to 1,457, all passing, on macOS and inside the Linux image.

## 2. Method

**Read in full:** the harness source (`src/`), every prompt, the code-review skill, the earlier assessment in `docs/reports/`, and the Agent SDK 0.3.283 type definitions for every option used. I also read the local Hermes material: the operations guide in `~/dev`, and `hermes-claude-orchestration` (`hco`), particularly its job builder, sandbox and cloud-hosting plan. That repo already defines how Hermes dispatches Claude Code workers, so it sets the contract this team has to meet.

**Surveyed:** recovery-platform's packages, test commands, end-to-end tooling, CI, hooks, `.claude` contents and Linux hazards. A read-only agent did the survey; I checked the facts that drove a change (the scripts, `firebase.json`, the hook installer, the `.gitignore`) myself.

**Researched (sourced):**

- the Agent SDK's hosting, secure-deployment, permissions, sandboxing and authentication documentation;
- the SDK changelog (0.3.283 → 0.3.322);
- Anthropic's engineering posts on agents, multi-agent research, long-running harnesses and context engineering;
- Hermes Agent's Docker, terminal, kanban-worker and `claude-code` skill documentation;
- Maestro, Playwright and Firebase Emulator Suite requirements for Linux containers.

Sources are linked where they're used, here and in docs/deployment.md.

**Built test-first:** every behavior change has a test that was run failing before the code was written.

**Reviewed independently:** two reviewers, a correctness/TypeScript reviewer and an adversarial security reviewer, were given the diff, not my conclusions. Their findings are in §4.

## 3. Findings and changes

Severity is what the finding meant for the goal: **Critical** blocks unattended use; **High** makes its results untrustworthy or unsafe; **Medium** degrades them.

### 3.1 No machine-readable result (Critical)

**Finding.** The CLI printed a colored trace and the manager's markdown to stdout, and stored nothing but text. Hermes's `claude-code` skill and `hco`'s job runner read `subtype`, `is_error`, `session_id`, `total_cost_usd` and `permission_denials` from `claude -p --output-format json` (`hco/jobs.py:375-441`). The team offered none of these, and its run summary dropped the SDK's `subtype` and its permission denials entirely.

**Change.**

- `--output json`: the trace goes to stderr, and stdout carries exactly one object (`src/report.ts`). The top level uses `claude -p`'s field names. `team` adds:
  - `outcome` (`done`, `partial`, `blocked`, `needs-decision` or `unknown`), parsed strictly from the manager's first section;
  - `question`, kept only for the outcomes that wait on the user;
  - `commit_message`, a new section of the manager's report;
  - `changed_files` (`git status`, read by the harness, not an agent);
  - `acceptance_tests`, `ledger`, `warnings` and the exit code.
- Startup errors produce the same shape with `subtype: error_startup`.
- A failed run never reports `success`. An auth failure arrives from the SDK as `subtype: success, is_error: true`; that was observed in the container, and is now `error_during_execution`.
- Approval prompts moved from stdout to stderr.

**Why this design.** Matching `claude -p`'s names lets `hco` and Hermes's skill read the team without new parsing. The team-specific fields carry what an orchestrator can't otherwise know: whether to commit, resume with an answer, or escalate. docs/deployment.md §6 maps each outcome to an action.

**Tests.** `src/report.test.ts`, `src/cli.test.ts`, `src/orchestrator/summary.test.ts`, `src/changed-files.test.ts`, and `src/cli-json.test.ts`, which spawns the real CLI and checks that stdout is a single JSON line for every startup failure.

### 3.2 Unattended runs could verify nothing (Critical)

**Finding.** Under `--yes`, Bash commands are refused unless an allow rule covers them, and `DEFAULT_ALLOWED_TOOLS` was empty (`src/allowlist.ts`). recovery-platform's own `.claude/settings.json` allows nothing for tests either. So qa-tester could not run a single test, which made "never report done without evidence" impossible to satisfy.

The profile text also told agents to run `npm test` "in `regroup/functions`". The natural spelling, `cd regroup/functions && npm test`, is a compound command, which allow rules don't approve.

**Change.**

- Profiles gain `allow`: permission rules that pass the same validation as `--allow`.
- recovery-platform pre-approves each package's `npm --prefix <pkg> test` (prefix, so Jest options can follow `--`) and its exact `typecheck`, `lint` and `build` scripts, plus read-only git. regroup adds its packages and two exact emulator commands.
- The profile text now gives agents exactly these forms, and says that dependencies are installed before the run.

**Why exact rules.** A prefix rule on a program that runs any script it's given (`firebase emulators:exec:*`, `npx:*`, `node:*`) is an unrestricted shell. `hco` refuses such rules for the same reason (`hco/sandbox.py:unsafe_entries`), and a test fails if a built-in profile adds one.

regroup's rules suite needs running emulators, and its documented command was a compound `cd firebase && … "cd .. && npx jest …"`. The replacement runs from the root as a single command: `firebase emulators:exec --config regroup/mobile/firebase/firebase.json … "npm --prefix regroup/mobile run test:rules"`. Its semantics were verified (the script runs in the package directory with `FIRESTORE_EMULATOR_HOST` set) on a scratch project, and again inside the container with no network.

**Tests.** `src/profiles/profiles.test.ts`: every built-in profile's rules validate with no warnings, and none is a script-runner prefix.

### 3.3 The recovery-platform profiles were unusable as documented (High)

**Finding.** Every path and command in the recovery-platform and regroup profiles is relative to the monorepo root (`regroup/CLAUDE.md`, `recovery-api/src/config/apps.ts`, `.claude/skills/…`). Yet detection chose `regroup` only when `--cwd` was inside `regroup/`, and the README's example used `--cwd ../recovery-platform/regroup`. With that cwd, no path resolved, the root's `CLAUDE.md` and `.claude` tree didn't load, and unattended reads above `--cwd` are refused.

**Change.** Profiles gain `root(cwd)`, inherited through `extends`. When it's set, the run requires `--cwd` to be exactly the root. Anything else is refused with the exact flags to use (`--cwd <root> --profile regroup`). The README and profile text say so.

**Tests.** `src/profiles/profiles.test.ts` ("profile root"). Also checked against the real checkout, which `--roles` refuses from `regroup/` and accepts from the root.

### 3.4 Nothing made the team work test-first (High)

**Finding.** The engineers' prompts asked for tests together with the code, and qa-tester wrote regression tests after the fact. No role wrote tests before implementation, and nothing checked that a test had ever failed. recovery-platform's own rule (`.claude/rules/tdd.md`) is the opposite: "Features start with a failing test." Anthropic's guidance for coding agents is likewise to write the failing test first and to keep the evaluator separate from the generator ([best practices](https://code.claude.com/docs/en/best-practices), [harness design](https://www.anthropic.com/engineering/harness-design-long-running-apps)).

**Change.**

- **The manager's workflow** has a new step 4, Tests first. For any behavior change, after the specification and before any engineer, qa-tester writes failing acceptance tests per criterion, at the level that proves it: unit, emulator integration, or end-to-end. The manager checks that each fails for the reason the criterion names, then briefs the engineer with the test paths. Done means those tests pass unchanged. Skipping the stage is allowed only for changes with no behavior, and the manager must say so.
- **The quality bar** requires red then green in the harness record: the same acceptance-test command failing in qa-tester's delegation and passing after the implementation.
- **The shared team conventions** gain a `<test_first>` section that binds every role that changes code: write the test first and see it fail; you can't edit the acceptance tests; never weaken a test; report the failing run and the passing one. It lives in the conventions rather than in each engineer's `<workflow>`, because a profile's `core` replaces `<workflow>`. regroup's frontend, mobile and database roles lose theirs, and TDD would have gone with it. A test pins this.
- **qa-tester** gains a `<test_first_brief>` mode with its own report: the tests written, each one's failing output, the tests written but not run here, and any stubs it added.
- **code-reviewer's skill** checks tests as a kind of code. Each behavior change needs a test that fails without it, acceptance tests must still test their criteria, and there must be no `.skip`, `.only`, weakened assertion or rewritten snapshot.
- **The engineers' report formats** ask for the failing run before the change and the passing run after.

**Why qa-tester writes them.** The independent author makes the tests a contract: an engineer can't shape the tests to fit the code. This matches recovery-platform's own implementer gate (`.claude/agent-gates/implementer.settings.json` blocks implementers from editing test files), and Anthropic's evaluator/generator separation.

**Tests.** `src/tdd-prompts.test.ts` pins each of these in the generic team and under the regroup profile.

### 3.5 Acceptance tests could be edited to green (High)

**Finding.** With the workflow above in prompt text only, an engineer could still edit a failing acceptance test until it passed.

**Change.** `src/test-authorship.ts`, wired into every run: once qa-tester writes a file, other roles' Write, Edit, MultiEdit and NotebookEdit calls to it are denied. The denial gives a reason that tells the engineer to report a wrong test as a spec gap. A file is matched by device and inode as well as by canonical path, so a hard link, a renamed directory or a case variant (APFS, or a Docker bind mount from macOS) is still the same test. Those three were bypasses until the security review found them; see §4. A file deleted and rewritten is matched by path. Shell edits aren't tracked, and the documentation says so: the reviewer's checks and the repository's commit gate cover them.

**Tests.** `src/test-authorship.test.ts` (9 cases), and `src/orchestrator/wiring.test.ts`, which runs the lock through a run's own hook lists.

### 3.6 Nothing stopped the team shipping (High)

**Finding.** The safety layer blocked destructive git and database commands, but allowed a plain `git push`, `firebase deploy`, `gcloud … deploy`, `eas submit`, `gh pr merge` and `gh workflow run`. Unattended, these are refused unless an allow rule covers them. But one broad rule (`Bash(npm run:*)`, or a target's settings) would let a `deploy` script run. The cloud-hosting plan and `hco` both state that jobs never push, merge or deploy.

**Change.** `RELEASE_COMMANDS` in `src/permissions/shell.ts` hard-denies, at a command position, however launched (path, `env`, `npx`/`pnpm exec`/`yarn dlx`/`bunx`, bare `pnpm <bin>`, `node <script>`, version pins):

- firebase deploys and destructive project operations;
- package scripts whose name contains `deploy`;
- gcloud deploy, delete, submit and rm, and gsutil rm and rb;
- eas build, submit and update, and fastlane;
- vercel, railway, netlify, terraform, kubectl, docker push, pulumi, wrangler, serverless and cdk deployments;
- `stripe --live`;
- git push, send-pack and http-push;
- gh PR create, merge, close, edit, ready and reopen, gh release, workflow run and repository changes, and gh api writes to pulls, merges, releases, refs and dispatches.

`grep "firebase deploy"`, commit messages, `npm test -- deploy`, `kubectl get` and `gh pr view` stay allowed. Main's policy previously allowed a plain push on purpose, so the existing tests that said so were updated, with the reason recorded here.

**Tests.** `src/permissions-release.test.ts` (147 cases, deny and allow).

### 3.7 Code that runs outside the run, and file writes through git (High)

**Finding (from the security review, confirmed).**

- recovery-platform's installed git hooks call scripts from the working tree. A dispatcher committing on the host would run code the team wrote, with the host's access.
- CI workflows run with repository secrets once the branch is pushed.
- `git diff`/`log`/`show --output=<file>` writes files through an allow-listed read command, which the file-tool checks never see.

**Change.**

- File-tool and shell writes to `.github/workflows`, `.husky`, `.githooks` and `scripts/git-hooks` are denied. The reason says the operator makes such changes.
- git read commands with `--output` or `--open-files-in-pager` are denied.
- docs/deployment.md requires the commit to happen inside a job container, never on the host, and says how to run the repository's gates from the base commit, as its CI test-tamper job does.

**Tests.** `src/permissions-release.test.ts`.

### 3.8 No container, and unverified assumptions about one (High)

**Finding.** No image existed. The research raised four concerns:

- firebase-tools 15 needs Java 21;
- the emulators download their JARs at first use, which needs network;
- bubblewrap works only weakened inside unprivileged Docker;
- session transcripts are lost on restart without a volume.

Building the image surfaced two more:

- firebase-tools writes a log into the working directory;
- tmpfs mounts are root-owned, which breaks a non-root user.

**Change.** `Dockerfile` and `.dockerignore`:

- Node 22 (trixie), git with `safe.directory /workspace`, Java 21, firebase-tools 15.29.0 and pnpm pinned;
- the Firestore, Storage, Database and UI emulators pre-fetched;
- tini;
- the harness installed as root and run as uid 1000, so a run can't modify the code that enforces its policy;
- `CLAUDE_CONFIG_DIR` declared as a volume.

The entrypoint calls the harness's own tsx by path, because `node --import tsx` would resolve tsx from the target's checkout.

**Verification.** All in the container:

- the unit suite passes (1,457);
- `--profiles` lists the profiles;
- the root check holds on a mounted fake monorepo;
- the emulator command passes with `--network none`, under `--read-only --cap-drop ALL --security-opt no-new-privileges` and tmpfs mounts with `uid=1000`;
- a team run with no credentials and no network starts the SDK's bundled Linux binary and returns a well-formed JSON error;
- `touch` on the harness source is refused.

### 3.9 Credentials and policy (High, operational)

**Finding.** The local Hermes guide runs Claude Code on a Max subscription token. Anthropic's terms ask products built on the Agent SDK to use API keys, and state that subscription limits assume ordinary individual usage ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)). An always-on server running parallel multi-agent jobs doesn't fit that.

**Change (documentation).** docs/deployment.md §3:

- the run container gets exactly one secret, an API key;
- never a production credential (no Firebase token, service-account file, live Stripe key or GitHub write access);
- an optional egress proxy keeps the key out of the container entirely.

The deny rules make deploying hard; absent credentials make it impossible.

### 3.10 Smaller corrections

- The recovery-platform profile told agents "use `git -C <path>`", which contradicted the team conventions ("`git log`, not `git -C /abs/path log`"). From the root, plain read-only git works, so the profile now says that.
- The profile's commit-message rule is now the manager's suggested-commit-message rule, since the team doesn't commit.
- The deploy skills are marked as not for the team.
- The profile now names the repository's actual commit gates: `verify-diff.sh` rejects deleted tests, `.skip`, `.only`, `xit`, `expect(true)`, `.snap` changes and test-count drops.

## 4. Independent review of this change

Two reviewers worked from the diff alone. Every finding was checked and then fixed, or deliberately left with its reason.

| Finding                                                                                                                     | Severity         | Disposition                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Approval prompts wrote to stdout, which would corrupt JSON on a TTY                                                         | High             | Fixed: prompts on stderr                                                                                                                         |
| Release patterns missed commands followed directly by `;`, `\|`, `&&`, `)`, a backtick or `>`                               | High             | Fixed: a shared word boundary, with tests for each form                                                                                          |
| Release patterns missed `env`, `node <bin>`, `pnpm <bin>`, `npm run -w x deploy`, `gh -R`, gh api writes, more deploy tools | High/Low         | Fixed, with tests                                                                                                                                |
| Approved test commands run code the team can edit (package.json scripts, Jest config, tests)                                | High (by design) | Left: inherent in running tests. Documented as the reason for a credential-free, egress-restricted container and human review of `changed_files` |
| Test lock bypassed by case, hard link or directory rename                                                                   | Medium           | Fixed: inode identity                                                                                                                            |
| A question invented from prose starting with "Question"; `done-ish` read as `done`                                          | Medium           | Fixed: labels need their colon, outcomes are whole words, questions are kept only for needs-decision and blocked                                 |
| `git diff --output=<file>` writes through an allowed read                                                                   | Medium           | Fixed: denied                                                                                                                                    |
| Startup-error JSON had a different `team` shape                                                                             | Low              | Fixed: identical shape                                                                                                                           |
| Harness source writable inside the container; shared session volume                                                         | Low              | Fixed: root-owned harness; per-job session directory documented                                                                                  |
| `pnpm deploy` (a pnpm builtin) is denied                                                                                    | Low              | Accepted: a false positive with no use in this project                                                                                           |
| Interpreter one-liners (`python3 -c 'os.system(...)'`) and `$(…)` substitution of computed strings                          | Low              | Documented limit: pattern rules can't parse programs, which is why the container is the boundary                                                 |

## 5. Verification evidence

| Check                                                 | Result                                                                             |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `pnpm typecheck`                                      | clean                                                                              |
| `pnpm test` (macOS)                                   | 1,457 / 1,457                                                                      |
| Unit suite in the Linux image                         | 1,457 / 1,457                                                                      |
| `src/cli-json.test.ts` (spawns the CLI)               | stdout is a single JSON line for each startup failure                              |
| `docker build`                                        | succeeds; 2.1 GB                                                                   |
| Emulator, hardened, `--network none`                  | `EMU=127.0.0.1:8080 CWD=/workspace/regroup/mobile`, exit 0                         |
| Team run, hardened, `--network none`, no key          | `error_during_execution`, full `team` shape, profile `recovery-platform → regroup` |
| Harness writable by the run user                      | no (`Permission denied`)                                                           |
| `--roles` against the real recovery-platform checkout | refused from `regroup/`; accepted from the root with `--profile regroup`           |

Not verified: a real run with an API key (§6, item 1), and egress being limited to `api.anthropic.com`.

## 6. Recommended next steps (not done here)

In priority order:

1. **A supervised live trial.** Run one small regroup task end to end with an API key, a budget cap and `--strict`, then read the ledger. It answers questions only a real run can:
   - Does Claude Code approve `npm --prefix regroup/functions test -- --testPathPattern x` under the `test:*` prefix rule?
   - Does the manager follow the test-first stage?
   - Is red-then-green visible in the record?
   - Does `team.outcome` parse from a real report?

   Then run one task per product.

2. **Upgrade the Agent SDK** from 0.3.283 to 0.3.322 (current), behind that trial. Relevant changes in between:
   - an omitted `permissionMode` changed default twice (set explicitly here, so likely safe);
   - fork subagents are on by default (`fork` is already on the policy's built-in denylist);
   - hooks may now set `onFailure: "block"`;
   - `blockWritesOutsideWorkingDirectories` exists.

   Re-verify the undocumented `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS` behavior that `src/orchestrator/index.ts` relies on.

3. **hco integration.** Add a "dev-team" engine to `jobs.build_command` that runs the `docker run` from docs/deployment.md §5, commits inside a container with `team.commit_message`, and maps `team.outcome` to kanban states (`needs-decision` → block with the question). This change belongs in hermes-claude-orchestration.
4. **Mechanical red-then-green check.** The ledger already records every test command and its outcome. A `SubagentStop`/`Stop` check could flag an engineer delegation whose acceptance-test command never failed earlier in the run, instead of relying on the manager to read the record. This is the "verification gates" item (#5) in the earlier assessment.
5. **recovery-platform fixes that help the team.** These are in that repo, which another session held at the time:
   - the root Prettier hook's hardcoded `/Users/marcusklein` path;
   - npm scripts that wrap the emulator suites (`test:rules:emu`), so the allow rules don't need to spell out `emulators:exec`;
   - regroup's missing Detox configuration;
   - `regroup/mobile/.node-version` says 18 while CI uses 22;
   - coverage floors aren't enforced anywhere automated.
6. **Device and browser end-to-end tests.** Run the Maestro flows the team writes through Maestro Cloud from CI (it exits 0/1 and covers iOS), or on a Mac. If the web apps adopt Playwright, add a pinned `mcr.microsoft.com/playwright` image, and give qa-tester a localhost-only Playwright MCP, as the earlier assessment proposed.
7. **Cost tuning after the trial.** Five roles run on Opus. Measure per-role spend from the trial before changing any model tier, since the earlier commits chose Opus for the judges on purpose.

## 7. Residual risks

- **The safety layer matches text.** It stops accidents and obvious misuse, not an adversarial model; the container, its missing credentials and its egress limits are the boundary. That is stated in the code, the prompts and the deployment guide.
- **The team may not follow the workflow perfectly.** The test-first stage is a prompt instruction, enforced only partly by the harness (the lock, the record). The manager could skip it and say so. Item 4 above would make that visible mechanically.
- **The team could commit on its own.** Nothing hard-denies `git commit`, and the conventions ask the team to leave changes uncommitted. If it commits anyway, `changed_files` will be short. Check `git log <base>..HEAD` in the job's clone as well.
- **The cost of multi-agent runs is high.** Anthropic reports multi-agent systems using about 15x the tokens of a chat. Keep `--max-budget` on every job, and remember it is an estimate.

## 8. Second pass: the recovery-platform agent changes

PR #7 (the project profiles) merged into main as `15e0d02`, unchanged from its conflict resolution. This pass re-reviewed the recovery-platform and regroup profiles in that state, plus this branch's additions, for one question: is every claim they hand the agents true of the repository today?

**Method.** Two reviewers fact-checked the profiles claim by claim against recovery-platform's source, package files and own CLAUDE.md and rules files, citing `path:line`; I re-checked every finding that drove a change. About 95 claims were correct. These were wrong, and are fixed:

| Claim | Was | Now |
| --- | --- | --- |
| Money units | "`payments` documents store `amount` in dollars", and the app overlay said rents were cents | Rents are dollars and `rentOwed`/`choreFees` cents (`regroup/mobile/src/util/money.ts`); new `payments.amount` writes are cents, but pre-#82 documents are mixed with no unit field. Getting this wrong is the 100x charge the repo's own comments warn about |
| Integration command | `… run test:integration` | `… run test:integration -- --forceExit`: the script lacks it and `emulators:exec` would wait on open handles |
| Commit gate path | `scripts/verify-diff.sh` | `.claude/agent-gates/verify-diff.sh`, plus the rules it also enforces (`.todo`, `xdescribe`, `expect(1)`, renames to non-runnable paths) |
| Search exclusions | all `lib/` directories | only compiled `recovery-api/lib/` and `*/functions/lib/`; other `lib/` directories are source |
| Commit scopes | "must name the product" | the hook rejects only bare `mobile`/`web`/`functions`; the manager still suggests a product scope |
| Entitlement | `entitlement.ts` alone | `entitlement.ts` (status) and `tierAllows` (tier features), Phase A fail-open, deliberately ungated paths, `.claude/rules/regroup-paywall.md` |
| Callable skill | "follow `regroup-new-callable`" | follow its shape, not its deleted per-house/per-guest billing calls |
| Logger | `firebase-functions/logger` | `import { logger } from "firebase-functions"`, as 29 files do |
| Migrations | "default to a dry run" | dry-run/run pairs; some `:run` scripts apply without a flag |
| Production reads | "inspect read-only through ADC" | out of reach from a credential-free run; the operator's task |
| CLAUDE.md authority | authoritative over the profile | authoritative except for command spelling, where the profile's pre-approved forms win |

Also added, because the agents needed them and only found them by chance:

- the testID convention (`screen-element-role`);
- test file naming for the Jest and emulator configs;
- the `debug-logger.ts` PII trap;
- zod v3 in the app versus v4 in functions;
- the Firebase JS SDK v8 in the web portal;
- a web-engineer verification command, CI's `tsc -p tsconfig.spec.json`, now allow-listed;
- `regroup/mobile/_legacy/`;
- `RENT_FEE`;
- `apps.ts` winning over the referral skill's table.

**A run-breaking finding.** recovery-platform's root `.claude/agents/product-manager.md` shares the team role's name. It is rejected (correctly), but as a configuration warning, so every `--strict` run against recovery-platform would have exited 3, and the dispatcher's "needs a check" signal would have been always on. Profiles can now list `shadowedProjectAgents`, whose rejection is a notice; recovery-platform lists `product-manager`. Tests: `src/project-agents.test.ts`, `src/profiles/profiles.test.ts`.

**Drift found in recovery-platform itself** (for that repo, not fixed here):

- `.claude/skills/regroup-new-callable/SKILL.md` still templates the deleted billing model.
- `.claude/skills/new-referral-flow/SKILL.md` maps `treatment-center` differently from `apps.ts`.
- `regroup/functions/CLAUDE.md` still says `payments.amount` is dollars.
- `regroup/mobile/.claude/rules/testing.md` points at a `.maestro/flows/` directory that doesn't exist.
- The comment in `jest.config.rules.js` says firestore only, though the suite needs storage and auth too.
- `regroup/mobile/.claude/rules/conventions.md` teaches domain commit scopes, while the root CLAUDE.md asks for product scopes.

**Still missing:** product profiles for homegroups, recovery-api and detox-recovery. Tasks there get the platform context with stack-neutral specialists: a web-oriented frontend engineer for homegroups' React Native app, for example. Write them the way regroup's was written and fact-checked, starting with the product the next task targets.
