# Testing

How to run the tests, how the suite is organized, how to write a new test in each area, and the checks that need a live model or a container.

**Contents**

1. [Running the tests](#1-running-the-tests)
2. [How the suite is organized](#2-how-the-suite-is-organized)
3. [Conventions](#3-conventions)
4. [Writing tests, area by area](#4-writing-tests-area-by-area)
5. [Test-driven changes and review rounds](#5-test-driven-changes-and-review-rounds)
6. [Environment caveats](#6-environment-caveats)
7. [Live and manual checks](#7-live-and-manual-checks)
8. [What runs on GitHub](#8-what-runs-on-github)

## 1. Running the tests

| Command                                                                            | What it does                                                                                                       |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `pnpm test`                                                                        | The whole suite: `node --import tsx --test "src/**/*.test.ts"`. About 1,600 tests in 25 files, in about 5 seconds. |
| `pnpm typecheck`                                                                   | `tsc --noEmit` over `src/` (tests included) and `scripts/`.                                                        |
| `node --import tsx --test src/publish.test.ts`                                     | One file.                                                                                                          |
| `node --import tsx --test --test-name-pattern="renamed" src/changed-files.test.ts` | Matching tests only. Module-level and `describe`-body setup still runs.                                            |
| `node --import tsx --test --experimental-test-coverage "src/**/*.test.ts"`         | With Node's coverage table. There are no thresholds; line coverage is about 98.7%.                                 |

Before a PR, run both `pnpm typecheck` and `pnpm test`. Nothing on GitHub runs them for you ([§8](#8-what-runs-on-github)).

The tests need no network, no Claude credential and no global git identity. They use Node's built-in runner (`node:test`) with `node:assert/strict`, loaded through `tsx`, so there is no test framework to install.

## 2. How the suite is organized

Tests sit next to the code they cover, as `src/**/*.test.ts`.

| Area                        | Files                                                                                                                                                                                                                                                                            | Covers                                                                                                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI                         | `cli.test.ts`, `cli-json.test.ts`                                                                                                                                                                                                                                                | Argument parsing, `--cwd` checks, help text; the real CLI spawned for JSON startup errors, the no-TTY refusal and `--publish` end to end                                |
| Run wiring                  | `orchestrator/wiring.test.ts`, `orchestrator/summary.test.ts`                                                                                                                                                                                                                    | The SDK options `prepareRun` builds, with the hooks called directly; folding SDK messages into a summary                                                                |
| Prompts and team            | `prompts.test.ts`, `team.test.ts`, `tdd-prompts.test.ts`                                                                                                                                                                                                                         | `.claude/dev-team/` customizations, placeholders, prompt structure, role tools and caps, the team plugin, and the test-first contract in the prompts                    |
| Profiles and project agents | `profiles/profiles.test.ts`, `project-agents.test.ts`                                                                                                                                                                                                                            | Detection, composition, external modules, the root check, profile allow rules (including "`generic` equals the built-in team"); loading and vetting the target's agents |
| Safety policy               | `permissions.test.ts`, `permissions-hook.test.ts`, `permissions-bypasses.test.ts`, `permissions-round2.test.ts`, `permissions-round3.test.ts`, `permissions-messages.test.ts`, `permissions-message-false-positives.test.ts`, `permissions-release.test.ts`, `allowlist.test.ts` | Every deny and allow rule, each bypass found in review, commit-message screening, release commands, git read confinement, npm overrides, allow-rule validation          |
| Evidence                    | `ledger.test.ts`, `ledger-integrity.test.ts`, `test-authorship.test.ts`, `outcome.test.ts`, `report.test.ts`                                                                                                                                                                     | Ledger recording, redaction and evidence text; the acceptance-test lock; exit codes; parsing the manager's report and the JSON result                                   |
| Publish                     | `publish.test.ts`, `changed-files.test.ts`                                                                                                                                                                                                                                       | Committing and pushing against real local git remotes, hooks without the token; `changed_files`                                                                         |

The suite is large because many tests are generated from case tables: one `it` per command in a list.

There is also a separate suite for the PR reviewer's project checks, `node --test '.pr-review/checks/test/*.test.mjs'`. It isn't part of `pnpm test`.

## 3. Conventions

- **No mocks.** Nothing calls the model. Orchestrator tests call `prepareRun()`, which only builds the SDK options, and then invoke the hooks from `queryOptions.hooks` directly. SDK messages are hand-built literals (`as unknown as SDKMessage`). CLI spawn tests fail before the SDK starts, and blank the credentials.
- **Real files and git.** Tests make temporary projects with `mkdtempSync(join(tmpdir(), "sdt-<name>-"))`, and real git repositories with real hooks. Policy suites wrap the directory in `realpathSync`, because the policy resolves `--cwd` to its real path, and macOS's temp directory sits behind a symlink. Temp directories aren't cleaned up.
- **No lifecycle hooks.** Only `describe` and `it`; setup happens at module scope or inside a `describe` body.
- **Imports** use `.js` specifiers (`import { publish } from "./publish.js"`), as `nodenext` module resolution requires.
- **Strict types.** `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are on and tests are typechecked, hence the `!` and `?? ""` you'll see.
- **Pin the deny reason.** The round, bypass, release and message suites assert the reason text (`/outside the project/`), not just that something was denied. That way a rule can't start blocking for the wrong reason unnoticed. The older `check()` table in `permissions.test.ts` only asserts deny or allow; prefer the reason-pinning helpers for new cases.

### Helpers you'll reuse

| Helper                                                      | Where                                                                                                                     | Use                                                                                                                                                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `denies(...)`, `allows(...)`                                | `permissions-release.test.ts`, the `permissions-round*` and `permissions-bypasses` suites, `permissions-messages.test.ts` | Case tables for the policy: each command becomes one test. Shapes differ slightly per file: `denies(commands)` against a fixed reason, or `denies(reason, cases)`. |
| `check(cases, "deny" \| "allow")`                           | `permissions.test.ts`                                                                                                     | The same, for tool calls of any kind (`[tool, input]` pairs). Asserts deny or allow, not the reason.                                                               |
| `fire(authorship, event, agent, tool, input)`               | `test-authorship.test.ts`                                                                                                 | Fire the lock's PreToolUse/PostToolUse hooks as a given agent; returns the deny reason.                                                                            |
| `preToolUse(options, tool, input, agent?)`                  | `orchestrator/wiring.test.ts`                                                                                             | Run all of a prepared run's PreToolUse hooks; returns the first deny reason.                                                                                       |
| `fire(ledger, input)`, `base(id, tool, input, agent?)`      | `ledger*.test.ts`                                                                                                         | Feed hook events to the ledger.                                                                                                                                    |
| `project()`, `result(outcome)`, `remoteLog(remote, branch)` | `publish.test.ts`                                                                                                         | A clone of a bare "GitHub" remote on `main`, a fake run result, and the remote's last commit.                                                                      |
| `run(args)`, `singleJson(stdout)`                           | `cli-json.test.ts`                                                                                                        | Spawn the real CLI with blank credentials; assert stdout is exactly one JSON line.                                                                                 |
| `section(prompt, name)`                                     | `tdd-prompts.test.ts`                                                                                                     | Extract one `<section>` from a prompt, to pin its wording.                                                                                                         |
| `projectWith(files)`                                        | `prompts.test.ts`                                                                                                         | A project with `.claude/dev-team/` files.                                                                                                                          |
| `compose(...profiles)`, `fakeMonorepo()`                    | `profiles/profiles.test.ts`                                                                                               | Compose ad-hoc profiles; a skeleton recovery-platform monorepo for detection tests.                                                                                |

## 4. Writing tests, area by area

### A safety rule

Add cases to a `denies` / `allows` table, for both sides of the rule, and pin the reason. The round suites define the helpers like this (`src/permissions-round2.test.ts`):

```ts
type Case = [tool: string, input: Record<string, unknown>];
const bash = (command: string): Case => ["Bash", { command }];
function denies(reason: RegExp, cases: Case[], p: Policy = policy) {
  /* one it() per case */
}
function allows(cases: Case[], p: Policy = policy) {
  /* one it() per case */
}

describe("git diff reads only the project", () => {
  denies(/outside the project/, [
    bash("git diff --no-index /etc/passwd /dev/null"),
    bash("git -C / diff etc/passwd dev/null"),
  ]);
  allows([bash("git diff"), bash("git diff main..HEAD -- src/a.ts")]);
});
```

For each deny, also test the spellings that have slipped past rules before:

- abbreviations (`--no-inde`, `--scr`);
- wrappers (`env`, `bash -c`, `npx`);
- compound commands (`&&`, `;`, `$(…)`);
- directory changes and variables (`cd`, `GIT_WORK_TREE=`, `+=`, `read`).

The allows matter as much: they catch over-blocking.

Keep policy cases in `denies`, `allows` or `check` tables. The PR reviewer's loosening check reads only those tables and the accepted-false-positive list; a case written as a plain loop is invisible to it. The "security review" suites in `permissions-release.test.ts` were written as plain loops and so are invisible to it. Convert them to tables when you next touch them.

### A prompt change

Pin the behavior the harness relies on, not the prose. `tdd-prompts.test.ts` asserts that the manager's `<workflow>` still sends acceptance tests to qa-tester first, and that the `<safety>` sections still name CI workflows and git hooks. `team.test.ts` asserts every role has `<role>`, `<output_format>` and `<verification>`, plus the shared sections. A new promise in a prompt that the harness enforces deserves a pin like these.

### A profile

`profiles/profiles.test.ts` renders every built-in profile and checks that its allow rules validate with no warnings and contain no script runners. For a new profile, add detection cases if it has `detect`, and composition cases if it adds roles or overlays `core`. Keep "`generic` equals the built-in team" passing.

### Wiring

Build options with `prepareRun({ task, cwd, autoApprove: true, … })` and assert on them: the permission mode, the hooks, the agents, the allow rules. Call hooks with `preToolUse(options, …)`. This tests what the SDK would receive, without calling the SDK.

### The CLI

Use `cli.test.ts` for parsing. Use `cli-json.test.ts`'s `run()` for behavior that needs the real process: exit codes, stdout versus stderr, a startup error in JSON. Keep spawned cases on paths that end before the SDK runs.

### Publish and git

Use `publish.test.ts`'s `project()` for a real clone of a bare remote. Install hooks with `writeFileSync(join(cwd, ".git/hooks", name), …)` and `chmod 0o755`. To prove a value never reached a hook, have the hook write `env` to a file and assert the value is absent.

## 5. Test-driven changes and review rounds

Work test-first:

1. Write the failing test.
2. Run it, and check it fails for the right reason (an assertion about the missing behavior, not a typo).
3. Make the change, and run it green.
4. Run the full suite.

Describe blocks named after a review round record that history, and are the place to add the next round's cases:

- `review round N` and `security review round N`;
- finding ids such as `C1`, `I1`–`I10`, `R2-n`.

The `permissions-round*` and `permissions-bypasses` suites feed each case exactly as the reviewer reproduced it.

## 6. Environment caveats

- **Don't run the suite as root.**
  - `cli.test.ts` skips its chmod-000 test as root.
  - The unreadable-directory case in `permissions-round3.test.ts` and the unreadable-file case in `project-agents.test.ts` expect `EACCES` and fail as root, since root reads anything.
  - The Docker image runs as the `node` user, so they pass there.
- **Case-insensitive filesystems.** One `test-authorship.test.ts` case only applies where the filesystem ignores case (macOS by default). Elsewhere it returns early, and is reported as passing, not skipped.
- **git.** The fixtures use `git init -b main` and `git switch` (git 2.28+). Publish's pre-push step needs `git hook run --to-stdin`. Fixtures pass their own identity (`-c user.email=t@t -c user.name=t`).
- **Node 22.** The `"src/**/*.test.ts"` glob in `pnpm test` relies on Node's `--test` expanding globs.

## 7. Live and manual checks

Some guarantees depend on the model or the SDK at runtime, so no unit test can cover them.

### The SDK's own permission matching

```bash
pnpm check:sdk-permissions
```

`scripts/check-sdk-permissions.ts` runs the SDK live with only `Bash(git diff:*)` allowed, no harness hook and no settings, in a temporary git repo. It checks 21 commands: plain diffs, chains with read-only commands, paths outside the directory, directory changes, wrappers, variables, redirects and substitution. It expects the SDK to approve some and refuse the rest. It costs a few cents on Haiku and uses whatever credential the SDK finds. It exits 1 if a command it expects refused actually ran.

**Run it before any SDK upgrade**, and update [security.md S11](security.md) with the result.

### The container

[deployment.md §2](deployment.md#2-build-the-image) builds the image and smoke-tests it with `--profiles`. The readiness review checked in a container that:

- the suite passes;
- the root check holds;
- the emulators work under `--network none`;
- a run with no credential still prints well-formed JSON;
- the harness files can't be written.

### A supervised live run

The one test of the whole system is a real run. [The readiness review §6](reviews/2026-11-10-standalone-readiness.md) describes the trial: one small regroup task with an API key, a budget cap and `--strict`. Then read the ledger, and check:

- that the test-first stage happened;
- that red-then-green shows in the ledger;
- that `team.outcome` parsed;
- that the profile's test commands were approved.

Do this before trusting unattended runs, and after an SDK upgrade.

### Interactive approval of a target's `allow: ["Bash"]`

A PreToolUse deny wins over a target repository that declares `permissions.allow: ["Bash"]`. This was verified by hand against SDK 0.3.283; no automated test covers it. Re-check it by hand on an SDK upgrade.

## 8. What runs on GitHub

**No workflow runs the tests or the typecheck.** Run both locally before every PR. What does run:

- **`pr-review.yml`**, on non-draft PRs into `main` from this repository (forks and Dependabot are skipped), and again when one is merged. An advisory reviewer that comments only, and is never a required check. Security-relevant findings go to private draft advisories under the Security tab. Its project checks and its knowledge come from the PR's base commit, never the head.
- **`claude.yml`**, on `@claude` from the owner, a member or a collaborator. Claude may run `pnpm test`, `pnpm typecheck` and `node --import tsx --test …` when asked; nothing runs them automatically.
- **`pr-review-learn.yml`**, weekly. Proposes reviewer-memory changes as one PR.

See [CONTRIBUTING.md](CONTRIBUTING.md#automation-on-pull-requests) for how to work with them.
