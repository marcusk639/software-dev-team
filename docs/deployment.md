# Running the team unattended: Docker, Hermes and recovery-platform

How to run software-dev-team as a worker that an outer orchestrator (Hermes Agent, through `hco` or directly) starts once per job, against a checkout of recovery-platform, in a container on a cloud server. Every command and flag here was run while writing this guide (2026-11-10), except where it says otherwise.

Contents:

1. [The model](#1-the-model)
2. [Build the image](#2-build-the-image)
3. [Credentials](#3-credentials)
4. [Prepare the job's checkout](#4-prepare-the-jobs-checkout)
5. [Run a job](#5-run-a-job)
6. [The result contract](#6-the-result-contract)
7. [Driving it from Hermes](#7-driving-it-from-hermes)
8. [What the team can and can't verify here](#8-what-the-team-can-and-cant-verify-here)
9. [Limits you should know](#9-limits-you-should-know)

## 1. The model

```
Hermes (plans, queues, talks to you on Telegram)
  └─ dispatcher (hco, or a Hermes kanban worker)
       ├─ 1. clone the repo into a private job directory, create branch hco/<id>
       ├─ 2. install dependencies (network on)                       §4
       ├─ 3. docker run software-dev-team --output json …  (network: API only)   §5
       │      └─ manager → specialists → tests → review; nothing committed
       ├─ 4. read the JSON result from stdout                        §6
       └─ 5. on done: docker run software-dev-team --publish result.json
             --branch hco/<id> (GitHub token, no API key): commit + push   §6
             otherwise: resume with an answer, or escalate                 §6, §7
```

The split is deliberate:

- **The team builds and verifies; it never ships.** The safety layer hard-denies pushing, opening, editing or merging pull requests, deploying, releasing and dispatching CI (`RELEASE_COMMANDS` in `src/permissions/shell.ts`). The team also leaves its changes uncommitted. It can't write CI workflows (`.github/workflows`) or git hooks (`.husky`, `.githooks`, `scripts/git-hooks`), because that code runs outside the run with more access than the team has. Committing and pushing is a separate, model-free step, `--publish` (§6), which takes the run's result and runs the repo's own commit gates (`.claude/agent-gates/verify-diff.sh`, the secret scan) as it commits.
- **The container is the security boundary.** The harness's command rules are pattern-based and best-effort: they stop accidents and obvious misuse, not a determined adversary. What makes an unattended run safe is what the container doesn't have: production credentials, write access to GitHub, and a network beyond the Anthropic API.

## 2. Build the image

```bash
docker build -t software-dev-team:$(git rev-parse --short HEAD) .
docker run --rm software-dev-team:<tag> --profiles   # smoke test
```

The image (`Dockerfile`) contains:

- Node 22 (Debian trixie).
- git, configured with `safe.directory /workspace`, since a mounted checkout is usually owned by another uid.
- Java 21 and firebase-tools 15.29.0 (v15 needs Java 21), with the Firestore, Storage, Database and UI emulators **pre-downloaded**, so test runs need no network for them.
- tini, so `docker stop` ends the run and every process under it.
- The harness, with its pinned Agent SDK. The SDK bundles the matching Claude Code binary, so there is no separate install.

It runs as `node` (uid 1000), never as root. The harness under `/opt/software-dev-team` is owned by root, so nothing the run does (a test, a script) can change the code that enforces its policy (verified). It is about 2.1 GB.

## 3. Credentials

Give the run container **exactly one secret**: `ANTHROPIC_API_KEY`.

- **Use an API key, not your Max subscription token.** Anthropic's terms ask products built on the Agent SDK to authenticate with API keys. They say Pro/Max limits "assume ordinary, individual usage of Claude Code and the Agent SDK", and Anthropic may enforce this without notice ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), [authentication](https://code.claude.com/docs/en/authentication)). A 24/7 server running parallel multi-agent jobs is not individual usage, so don't put `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` on it. If both are set, `ANTHROPIC_API_KEY` wins.
- **Never production credentials:** no Firebase deploy token or service-account JSON, no Stripe live keys, no Neon, Railway or Sentry tokens. The deny rules make deploying hard; absent credentials make it impossible. The regroup functions build copies `src/scripts/service-key.json` only if it exists. Keep it out of the job's checkout.
- **GitHub:** the run container needs no GitHub access. The dispatcher clones with a read-only deploy key or a fine-grained PAT, outside the run container. Only the publish step (§6) gets a write token: a fine-grained PAT with Contents read and write on this one repository, as `GITHUB_TOKEN`. Protect `main` with a branch protection rule, so even that token can't push to it: publish also refuses the default branch itself.
- **Stripe test mode:** the Jest suites mock Stripe. The `stripe:scenario:*` scripts need the Stripe CLI and test keys, so leave them out and the team will report them as not run.

Set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, so the only egress the run needs is `api.anthropic.com` (not verified here: confirm with your egress proxy's logs).

The API key is in the run's environment, so code the run executes (a test the team wrote, say) can read it. The safety layer stops shell commands that print the environment, not test code. Two choices:

- Accept it: the key can only spend money, so cap it with a spend limit on a dedicated workspace key.
- Remove it: run an egress proxy that injects the credential, as Anthropic's [secure deployment guide](https://code.claude.com/docs/en/agent-sdk/secure-deployment) suggests. Point `ANTHROPIC_BASE_URL` at the proxy and give the container a placeholder key.

## 4. Prepare the job's checkout

The team doesn't install dependencies: `npm ci` needs the network and the registry, and its result should be the same for every job, not left to a model. Prepare the checkout before the run, from the monorepo root, with network on:

```bash
git clone --shared /srv/repos/recovery-platform /srv/jobs/$ID/repo   # or your hco clone
git -C /srv/jobs/$ID/repo checkout -b hco/$ID origin/main
docker run --rm -v /srv/jobs/$ID/repo:/workspace --entrypoint sh software-dev-team:<tag> -c '
  set -e
  for p in recovery-api detox-recovery homegroups/functions regroup/functions regroup/e2e; do npm --prefix "$p" ci; done
  npm --prefix homegroups/mobile ci --ignore-scripts
  npm --prefix regroup/mobile ci --ignore-scripts && cd regroup/mobile && npx patch-package'
```

Install only the packages the task touches if time matters. regroup/mobile's postinstall runs CocoaPods, which fails on Linux. That is why it uses `--ignore-scripts`; its `patch-package` patches are load-bearing.

Write the task to a file outside the checkout (e.g. `/srv/jobs/$ID/task.md`), so it doesn't show up as a changed file.

## 5. Run a job

```bash
docker run --rm \
  --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
  --read-only \
  --tmpfs /tmp:rw,size=1g \
  --tmpfs /home/node/.config:rw,uid=1000,gid=1000 \
  --tmpfs /home/node/.npm:rw,uid=1000,gid=1000 \
  --memory 8g --cpus 4 --pids-limit 2048 \
  --network sdt-egress \
  -e ANTHROPIC_API_KEY -e CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  -v /srv/jobs/$ID/repo:/workspace \
  -v /srv/jobs/$ID/task.md:/task.md:ro \
  -v /srv/jobs/$ID/claude:/home/node/.claude \
  software-dev-team:<tag> \
    --cwd /workspace --profile regroup \
    --output json --yes --strict \
    --max-turns 80 --max-budget 30 \
    --file /task.md \
  > /srv/jobs/$ID/result.json 2> /srv/jobs/$ID/trace.log
```

Why each flag:

| Flag                                                      | Why                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--read-only` plus the three tmpfs mounts                 | The image can't be changed by a run. firebase-tools needs a writable `~/.config` and npm a writable `~/.npm`. tmpfs mounts are root-owned unless given `uid`/`gid`, and the emulators then fail with `EACCES` (verified).                                                                   |
| `--cap-drop ALL`, `no-new-privileges`, `--user 1000:1000` | Anthropic's [secure deployment](https://code.claude.com/docs/en/agent-sdk/secure-deployment) baseline.                                                                                                                                                                                      |
| `--network sdt-egress`                                    | A network whose only route out is an allowlisting proxy to `api.anthropic.com`. The emulators bind to localhost inside the container, so they need no egress. Two jobs' emulator ports can't collide, because each container has its own network namespace.                                 |
| `-v /srv/jobs/$ID/claude:/home/node/.claude` | Session transcripts live in `CLAUDE_CONFIG_DIR`. Without a volume, `--resume` can't continue a job after the container exits. Resume needs the same `--cwd` (`/workspace`) as the first run. Use one directory per job, not one shared volume, so nothing a run writes there reaches another job. The run loads only the project's settings (`settingSources: ["project"]`), not a `settings.json` in this directory. |
| `--cwd /workspace --profile regroup`                      | Profiles for recovery-platform give root-relative paths and commands, so the run must be at the monorepo root. A `--cwd` inside `regroup/` is refused with the flags to use instead. From the root, detection picks `recovery-platform`, so name the product profile explicitly.            |
| `--output json`                                           | One result object on stdout; the trace goes to stderr.                                                                                                                                                                                                                                      |
| `--yes`                                                   | Unattended. File edits inside `/workspace` run, and so do the commands the profile allow-lists (its `allow` rules: each package's `npm --prefix <pkg> test/typecheck/lint/build` and the exact emulator commands). Every other Bash command, WebFetch and MCP call is refused and recorded. |
| `--strict`                                                | Exit 3 when the ledger shows failed, blocked or refused calls that a later pass didn't supersede, so the dispatcher can't mistake an unverified run for a clean one.                                                                                                                        |
| `--max-turns`, `--max-budget`                             | Two independent brakes. `--max-budget` is the SDK's own cost estimate: it can overshoot and is not a bill. Track real spend on the Anthropic console.                                                                                                                                       |

Don't add `--allow "Bash(npm run:*)"` or `Bash(npx:*)`-style rules. They would let the team run any script, including one it just wrote; `--allow` refuses the worst of these (bare `Bash`, wildcard-only specifiers), but not all.

The OS sandbox (`sandbox` in the SDK options, bubblewrap on Linux) isn't enabled. Inside an unprivileged container, bubblewrap only works in a "weaker nested" mode, and Anthropic recommends the container itself as the boundary for unattended runs ([sandboxing](https://code.claude.com/docs/en/sandboxing), [sandbox environments](https://code.claude.com/docs/en/sandbox-environments)).

## 6. The result contract

For a run, stdout carries one JSON object, always, including for startup errors; it is the same shape either way. `--help`, `--roles` and `--profiles` are listings, not runs, and print text. The top level has the same names `claude -p --output-format json` uses, so a dispatcher written for Claude Code reads it unchanged:

| Field                                                               | Meaning                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subtype`                                                           | `success`, the SDK's error subtypes (`error_max_turns`, `error_max_budget_usd`, `error_during_execution`, …), `no_result` (the stream ended without a result) or `error_startup` (bad flags, profile or configuration; nothing ran). A failed run never says `success`, even when the SDK's own result did. |
| `is_error`                                                          | Whether the run failed.                                                                                                                                                                                                                                                                                     |
| `result`                                                            | The manager's final report (markdown), or the error.                                                                                                                                                                                                                                                        |
| `session_id`                                                        | Pass to `--resume` to continue.                                                                                                                                                                                                                                                                             |
| `num_turns`, `duration_ms`, `total_cost_usd`                        | As reported by the SDK. Cost is an estimate.                                                                                                                                                                                                                                                                |
| `permission_denials`                                                | Tool calls the SDK refused, accumulated over the run.                                                                                                                                                                                                                                                       |
| `team.outcome`                                                      | The manager's verdict: `done`, `partial`, `blocked`, `needs-decision`, or `unknown` when the report didn't follow its format.                                                                                                                                                                               |
| `team.question`                                                     | The manager's question when it needs a decision, else null.                                                                                                                                                                                                                                                 |
| `team.commit_message`                                               | The manager's one-line conventional commit message, using the repo's product scopes, or null.                                                                                                                                                                                                               |
| `team.changed_files`                                                | `git status` paths after the run, relative to the repo root. These are what to review and commit.                                                                                                                                                                                                           |
| `team.acceptance_tests`                                             | The test files qa-tester wrote: the tests the change was built to. No other role could edit them with file tools.                                                                                                                                                                                                |
| `team.ledger`                                                       | Every recorded tool call, by role, with its outcome.                                                                                                                                                                                                                                                        |
| `team.needs_check`, `team.warning`, `team.warnings`, `team.notices` | Ledger and configuration problems worth a look.                                                                                                                                                                                                                                                             |
| `team.exit_code`, `team.profile`, `team.strict`                     | As named.                                                                                                                                                                                                                                                                                                   |

Exit codes: `0` finished; `1` the run failed; `2` usage or startup error (nothing ran); `3` finished, but `--strict` found calls or configuration to check.

What the dispatcher should do:

| Exit, outcome                                      | Action                                                                                                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0, `done` | Review `changed_files` and `acceptance_tests` if you want to, then run the publish step below to commit and push the job branch. |
| 0 or 3, `partial`                                  | Commit to the job branch marked WIP or leave it uncommitted, and send yourself the report. `ledger` says what failed.                                        |
| 0, `needs-decision`                                | Send `team.question` to yourself (Telegram). Resume with the answer: `--resume <session_id> --file answer.md`, same `--cwd`, same volume.                    |
| any, `blocked`                                     | Usually a refused command (`permission_denials`) or a missing dependency. Fix the environment or the allow rules; don't loosen the safety layer.             |
| 1 with `error_max_turns` or `error_max_budget_usd` | Resume with a higher cap if the report shows progress; otherwise split the task.                                                                             |
| 2                                                  | A configuration bug in the job (flags, profile, `--cwd`). Fix it before retrying.                                                                            |
| 3                                                  | Treat like `partial` until someone has looked at `team.warning`.                                                                                             |

**Commit and push with `--publish`.** A model-free step in the same image commits the run's changes on the job branch and pushes the branch to GitHub:

```bash
docker run --rm --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
  -e GITHUB_TOKEN \
  -v /srv/jobs/$ID/repo:/workspace -v /srv/jobs/$ID/result.json:/result.json:ro \
  software-dev-team:<tag> --publish /result.json --branch hco/$ID --cwd /workspace
```

What it does:

- It reads the run's result and publishes only a `done` run. Add `--include-partial` to publish `partial` work, marked as such in the commit body.
- It commits every change in the checkout with `team.commit_message`, or `--message <text>`. The commit body names the session, the outcome and the acceptance tests.
- It runs the repository's commit hooks, so recovery-platform's test-tamper and secret gates apply. A rejected commit is reported as failed, and nothing is pushed.
- It pushes `HEAD` to `refs/heads/<branch>` on `--remote` (default `origin`). It never pushes to the remote's default branch or `main`/`master`, and never force-pushes: a branch with other history is refused.
- It refuses to commit any file that looks like it holds secrets (`.env*`, keys, credentials).
- It prints one JSON object (`{"type":"publish","status":"pushed|skipped|failed","reason",…}`) and exits 0 when pushed, 4 when there was nothing to publish (a run not done, or no changes), 1 on failure and 2 on bad arguments.

**Why a separate step:**

- The GitHub write token is only in a process with no agents in it, and the team's own shell can't push (`git push` is hard-denied in a run). This is the same split pr-review-kit makes between its model step and its publish step.
- It runs in the container, never on the host, because the repo's hooks call scripts from the working tree that the team could have edited. Run on the host, a commit would run the team's code with the host's access. In the container, it runs where the run did, with only the GitHub token.

Give this container network access to github.com only. To get the repo's gates without the team's edits as well, do what its CI test-tamper job does: run `.claude/agent-gates/verify-diff.sh` from the base commit.

## 7. Driving it from Hermes

A team run takes minutes to an hour: more than Hermes's default terminal timeout of 180 seconds. Kanban workers and `-q`/cron runs also get no completion notice ([Hermes tools](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/tools.md)). Two workable patterns:

- **Through hco (recommended).** `hco`'s detached runner already clones, branches, runs a worker with `--output-format json`, parses `subtype`/`is_error`/`session_id`/`total_cost_usd`/`permission_denials`, and finalizes the kanban card. Swapping its `claude -p …` command (`jobs.build_command`) for the `docker run` above needs these changes:
  - drop `-p`, `--restricted`, `--tools`, `--permission-mode` and `--settings`, since the container and the team's own policy replace them;
  - pass the task with `--file`;
  - replace "commit on the branch" in hco's job prompt with the `--publish` step after a `done` result. It commits and pushes the job branch, so hco's `fetch_branch` is only needed for a local copy.

  This is not built yet. It's a change in the hermes-claude-orchestration repo.

- **Directly from Hermes.** Start the `docker run` with the terminal tool's `background=true` and poll the process. When it exits, read `result.json` and follow §6.

Keep the concurrency low. Each job runs up to ten specialists on Opus and Sonnet, and a multi-agent run uses many times the tokens of a single session.

## 8. What the team can and can't verify here

| Layer                              | In the container                                                              | How the team handles it                                                                                                                                            |
| ---------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit tests (Jest, every package)   | Yes                                                                           | Run through the profile's `npm --prefix <pkg> test`                                                                                                                |
| Type checks, lint, builds          | Yes (regroup/web needs `--openssl-legacy-provider` and its suite isn't green) | Profile commands                                                                                                                                                   |
| Firestore and Storage rules suites | Yes, offline (verified)                                                       | homegroups `test:rules`; regroup's exact `emulators:exec --config … "npm --prefix regroup/mobile run test:rules"`                                                  |
| Emulator integration tests         | Yes                                                                           | regroup `test:integration` (24 of 48 already fail: the team compares against a baseline run)                                                                       |
| Mobile E2E (Maestro, Detox)        | No: they need a simulator or a KVM-backed emulator                            | qa-tester writes the flows and reports them as "written but not run". Run them on a Mac, or with Maestro Cloud from CI, before merging.                            |
| Web E2E / Karma                    | No browser in the image                                                       | Reported as not run. If recovery-platform adds Playwright, run it in the `mcr.microsoft.com/playwright` image, pinned to the project's `@playwright/test` version. |

For recovery-platform, the end-to-end layer the team can actually run is the emulator suites. That's where qa-tester puts new end-to-end coverage.

## 9. Limits you should know

- **The safety layer is best-effort.** Its shell rules match command text. A script the team writes and then runs through an approved command (a test file, say) runs whatever is in it. This is why the container has no credentials and no general network.
- **Test authorship is enforced for file tools only.** Once qa-tester writes a test file (`*.test.*`, `*.spec.*`, `*.cy.*`, `__tests__/`, `test/`, `e2e/`, `maestro/`, `test_*.py`, `*_test.go`, `*Tests.cs`, `MyAppTests/`…), other roles' Write and Edit calls to it are refused. The file is matched by identity (device and inode) as well as path, so a hard link, a renamed directory or another case on a case-insensitive filesystem doesn't get around it. A shell edit (`sed -i`, a redirect) isn't tracked. The code reviewer reads the acceptance tests against their criteria, and the repo's commit gate rejects skipped tests and test-count drops. `acceptance_tests` lists only files qa-tester wrote with file tools.
- **Approved commands run code the team can edit.** `npm --prefix <pkg> test` runs the package's test script and its Jest config, both of which are files the team may change. That is inherent in letting the team run its tests. It's why the run has no credentials and no general network, and why a person reviews `changed_files` (including any `package.json` or test-config change) before merging.
- **The target's own `.claude` settings load into every run** (`settingSources: ["project"]`). That includes recovery-platform's hooks. One of them runs Prettier through a hardcoded `/Users/marcusklein/...` path, so in the container it fails silently. Run your formatter in the dispatcher before committing, or fix the hook's path in recovery-platform.
- **The SDK is pinned at 0.3.283.** 0.3.322 is current. Upgrading is worth doing but needs a live check, because defaults the harness relies on changed in between (see the review's §6).
