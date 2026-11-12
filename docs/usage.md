# Using the team

How to run software-dev-team against a project, read what it reports, and tune it for that project. For running it unattended in Docker under an orchestrator, see [deployment.md](deployment.md); this page covers the CLI itself.

**Contents**

1. [Before you start](#1-before-you-start)
2. [Your first run](#2-your-first-run)
3. [Choosing a profile](#3-choosing-a-profile)
4. [Interactive and unattended runs](#4-interactive-and-unattended-runs)
5. [What a run prints](#5-what-a-run-prints)
6. [Answering a question: `--resume`](#6-answering-a-question---resume)
7. [JSON output and exit codes](#7-json-output-and-exit-codes)
8. [Pre-approving commands: `--allow`](#8-pre-approving-commands---allow)
9. [Customizing the team for a project](#9-customizing-the-team-for-a-project)
10. [The project's own agents](#10-the-projects-own-agents)
11. [Committing and pushing a run: `--publish`](#11-committing-and-pushing-a-run---publish)
12. [Command reference](#12-command-reference)
13. [Environment variables](#13-environment-variables)
14. [Troubleshooting](#14-troubleshooting)

## 1. Before you start

| You need             | Why                                                                                                                                                                                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node 22 and pnpm     | The CLI runs TypeScript through `tsx`. The image and the `@claude` workflow use Node 22 and pnpm 12.6.0.                                                                                                                                                                                      |
| git                  | `changed_files` and `--publish` read and write the target's git checkout. `--publish` runs hooks with `git hook run --to-stdin`, which older gits lack (the image has git 2.47).                                                                                                              |
| A Claude credential  | `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, or a logged-in Claude Code. With neither variable set, the run prints `No ANTHROPIC_API_KEY set; using stored Claude Code credentials.` and carries on. For unattended runs use an API key ([deployment.md §3](deployment.md#3-credentials)). |
| A project to work on | The team edits real files in `--cwd`, and loads that repository's `.claude` settings, hooks and MCP servers. Point it only at repositories you trust ([security.md S6](security.md)).                                                                                                         |

```bash
pnpm install
```

## 2. Your first run

```bash
pnpm start --cwd ../recovery-platform --profile regroup "Add a CSV export of payment history for operators"
```

1. The CLI resolves the profile and prints it to stderr, e.g. `profile recovery-platform → regroup  (Regroup (Recovery Platform))`.
2. The Engineering Manager reads the task, plans, and delegates to specialists. Tests come first: qa-tester writes failing acceptance tests before an engineer starts, and no other role can edit them with file tools.
3. Each tool call appears as it happens (`▸ Bash npm --prefix recovery-api test`). Without `--yes`, calls that need approval ask you on the terminal.
4. The manager ends with its report: **Outcome** (`done`, `partial`, `blocked` or `needs-decision`), what changed, the evidence, decisions, follow-ups, a suggested commit message, and any question.
5. The CLI prints what actually ran (the ledger), the acceptance tests qa-tester wrote, any warnings, and the session id.

The team leaves its changes **uncommitted** in `--cwd`. Review them like any other change, then commit them yourself or with [`--publish`](#11-committing-and-pushing-a-run---publish).

To see the team before running it:

```bash
pnpm start --profiles                                            # the built-in profiles
pnpm start --roles --cwd ../recovery-platform --profile regroup  # the team that would run there
```

`--roles` also loads every prompt customization, so it is the quick way to check a project's `.claude/dev-team/` files ([§9](#9-customizing-the-team-for-a-project)).

## 3. Choosing a profile

A profile specializes the stack-neutral team for one project: its technologies, conventions, commands and invariants. Under `regroup`, for example, the frontend engineer is a React Native, Redux Toolkit, React Query and Stripe specialist.

| Profile             | Extends             | What it adds                                                                                                                                                                                                |
| ------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generic`           | none                | Nothing: the stack-neutral team. The default.                                                                                                                                                               |
| `recovery-platform` | none                | Monorepo-wide rules: product data isolation through recovery-api, per-product vocabulary, PII-free logging, secrets, emulator ports, coverage ratchets, commit conventions, and pre-approved test commands. |
| `regroup`           | `recovery-platform` | Specializes every role for Regroup and adds a `web-engineer` for the Angular 9 portal.                                                                                                                      |

**Detection.** Without `--profile`, the profile is detected from `--cwd`. Among the profiles that match, the one with the longest `extends` chain wins; with no match you get `generic`. The recovery-platform monorepo is recognized by `recovery-api/src/config/apps.ts`.

**The root rule.** The recovery-platform profiles give paths and commands relative to the monorepo root, so they run only with `--cwd` at the root. Name the product explicitly:

```bash
pnpm start --cwd ../recovery-platform --profile regroup "…"   # right
pnpm start --cwd ../recovery-platform/regroup "…"             # refused, with the flags to use instead
```

**A profile from disk.** `--profile` also takes a path to a `.ts` or `.js` module whose default export is a profile. A selector with a `/` or `\`, or ending in `.ts`, `.js`, `.mjs`, `.cjs`, `.mts` or `.cts`, is treated as a path. Such a profile may `extends` a built-in one. Writing one is covered in [extending.md §2](extending.md#2-profiles).

<details>
<summary>The roles under <code>regroup</code></summary>

| Role                                                                              | Specialty                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| frontend-engineer                                                                 | React Native 0.72 app: TypeScript, Redux Toolkit 2 vs. React Query 5 state placement, UI component design, React Navigation 7, callables via @react-native-firebase, Stripe PaymentSheet, Formik/Yup, RN Testing Library |
| mobile-developer                                                                  | Native layer: iOS/Android build config, CocoaPods, native modules, permissions, FCM/notifee push, patch-package, release config                                                                                          |
| web-engineer                                                                      | Angular 9 + Universal SSR maintenance, ngx-stripe, Karma/Protractor/TSLint                                                                                                                                               |
| backend-engineer                                                                  | Cloud Functions v2 on Node 22, GCP (Cloud Run, Scheduler, Secret Manager, Logging), firebase-admin Firestore, Stripe Billing + Connect + webhooks, zod                                                                   |
| database-specialist                                                               | Firestore modeling, composite indexes, security rules and rules tests, migration scripts (replaces the SQL-oriented generic standards)                                                                                   |
| qa-tester                                                                         | The real test commands per package, emulator-backed rules suites, Stripe scenarios, entitlement-gate testing                                                                                                             |
| ux-designer, product-manager, architect, monetization-expert, business-strategist | Sober-living domain, Oxford House model, tier and entitlement model, Firebase architecture choices, GTM docs                                                                                                             |

</details>

## 4. Interactive and unattended runs

|                                                                                          | Interactive (default)                                                                                                    | Unattended (`--yes`)                                              |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Needs a terminal                                                                         | Yes. Without a TTY on stdin the run exits 2: `No TTY available for approval prompts. Re-run with --yes to auto-approve.` | No                                                                |
| File edits inside `--cwd`                                                                | Asked                                                                                                                    | Run (`acceptEdits`)                                               |
| `mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp`, `sed`                                       | Asked                                                                                                                    | Run                                                               |
| Commands an allow rule names (profile, `--allow`, the project's `.claude/settings.json`) | Run                                                                                                                      | Run                                                               |
| Other Bash, WebFetch, WebSearch, MCP tools                                               | Asked                                                                                                                    | Refused                                                           |
| Reads outside `--cwd`                                                                    | Asked                                                                                                                    | Denied, unless a `Read(//abs/dir/**)` rule opens the directory    |
| The safety hook                                                                          | Screens everything                                                                                                       | Screens everything, including the commands `acceptEdits` approves |

The safety hook runs in every mode and inside every specialist. No allow rule unlocks what it blocks: destructive commands, deploys, pushes and pull-request changes, reading secrets, and writing outside the project or to protected paths. [security.md](security.md) lists what it covers and its known limits.

**Limits.** `--max-turns <n>` caps the manager's turns (default 60); each specialist has its own cap (30 for advisory roles, 60 for implementers). `--max-budget <usd>` stops the run once its estimated cost, specialists included, passes the amount. There is no default budget, so set one for unattended runs.

## 5. What a run prints

In the default text mode, the trace goes to stdout:

| What you see                                                           | Meaning                                                                    |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `session <id>  model <model>  agents: <n>`                             | The run started.                                                           |
| Plain text                                                             | The manager's own messages, ending with its report.                        |
| `▸ Agent → backend-engineer  <description>`                            | A delegation.                                                              |
| `▸ Bash <command>`, `▸ Edit <path>` …                                  | A tool call. With `--verbose`, each result follows as `  ← …` (truncated). |
| `── complete` / `── failed` and `<turns> turns · <seconds>s · $<cost>` | The run ended.                                                             |

After the run, the CLI adds:

1. **What actually ran in this run**: the ledger. Every command and file change, with its outcome (`ok`, `failed`, `started` (left in the background), `blocked`, `refused` or `unfinished`), so you can check the report's claims against it. Successful reads aren't listed.
2. **Acceptance tests qa-tester wrote**: the test files only qa-tester could edit with file tools.
3. **Configuration warnings** (stderr): rejected project agents, allow rules with no effect, and similar.
4. **A warning** (stderr) when the ledger records calls to check (failed, blocked, refused, background or unfinished), when the ledger missed events, or when the run started with configuration warnings. It is printed with or without `--strict`.
5. **`Session: <id>`** and how to resume it, also when the run failed.

The profile line, warnings and approval prompts always go to stderr.

## 6. Answering a question: `--resume`

When the manager needs a decision, it ends with outcome `needs-decision` (or `blocked`) and a **Question**. Answer it by resuming the session:

```bash
pnpm start --resume <session-id> --cwd ../recovery-platform --profile regroup "Use cents everywhere; migrate old documents lazily."
```

Use the same `--cwd` and `--profile` as the first run. Nothing checks this for you. A resumed run resolves the profile again and starts a fresh turn budget.

The harness's own state doesn't carry over. The ledger and the acceptance-test lock live in the process, so a resumed run doesn't lock the tests qa-tester wrote before. Its `ledger` and `acceptance_tests` also cover only the resumed part.

## 7. JSON output and exit codes

`--output json` is for programs that drive the team. The trace and every message move to stderr, and stdout carries exactly one JSON object, also for startup errors. The exception is a run with no task: an empty task prints the help text and exits 0, so never pass one from a program.

```bash
pnpm start --output json --yes --strict --max-budget 5 \
  --cwd ../recovery-platform --profile regroup --file task.md > result.json
```

The object has the fields `claude -p --output-format json` reports (`type`, `subtype`, `is_error`, `result`, `session_id`, `num_turns`, `duration_ms`, `total_cost_usd`, `permission_denials`) plus `team`. `team` holds:

- the manager's `outcome` and `question`;
- the profile chain;
- `exit_code`, `strict`, `needs_check` and `warning`;
- `warnings` and `notices`;
- the `ledger` and `ledger_faults`;
- `changed_files` and `acceptance_tests`;
- the suggested `commit_message`.

The full field reference is [deployment.md §6](deployment.md#6-the-result-contract).

Two rules keep a failure from ever reading as success:

- An errored run whose SDK subtype says `success` is reported as `error_during_execution`. A run that never produced a result is reported as `no_result`.
- `team.outcome` is parsed from the manager's `Outcome:` line only when the run didn't error; otherwise it is `unknown`.

| Exit | Meaning                                                                                                                                                                                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | The run finished (or `--help`, `--roles`, `--profiles`, or no task was given, which prints the help). The outcome may still be `partial`, `blocked` or `needs-decision`, so read `team.outcome`.                                                                                                       |
| 1    | The run failed: an error result, a stream that threw, or no result at all.                                                                                                                                                                                                                             |
| 2    | Usage, configuration or startup error; nothing ran. Covers bad flags, an invalid `--cwd`, a profile error, an unknown customization file, a missing `{{roster}}`, and no TTY without `--yes`.                                                                                                          |
| 3    | Only with `--strict`: the run finished, but something needs a check. That covers calls left failed, blocked, refused, in the background or unfinished, ledger faults, and configuration warnings. A failed Bash call that a later run of the same command by the same specialist passed doesn't count. |
| 4    | Only with `--publish`: nothing to publish.                                                                                                                                                                                                                                                             |

## 8. Pre-approving commands: `--allow`

`--allow <rule>` lets one tool or command run without approval. It is repeatable, and uses Claude Code's rule syntax:

```bash
--allow "Bash(pnpm test:*)"        # a command and anything after it
--allow "Bash(git status)"         # exactly this command
--allow "Read(//srv/shared/docs/**)"   # reads in a directory outside --cwd
--allow "mcp__github__get_issue"   # one MCP tool
```

For read rules: `//` starts an absolute path, `~/` the home directory, and a single `/` or a bare path is relative to `--cwd`.

A run's rules are, in order:

1. `Grep` and `Glob` (always);
2. the profile's `allow` list;
3. your `--allow` rules.

Each is validated at startup. These are rejected, and the run exits 2:

- bare `Bash`, `Write`, `Edit`, `MultiEdit` or `NotebookEdit`;
- a wildcard-only specifier, such as `Bash(*)`;
- a write rule for the whole filesystem;
- a Bash rule the safety policy always blocks;
- a read rule for `/`, the home directory or a parent of `--cwd`, or one covering only one level (`dir/*`) outside it.

A prefix rule that also matches a blocked form gets a notice: `Bash(git reset:*)` also matches `git reset --hard`, which the safety policy still blocks. A read rule outside `--cwd` with any wildcard other than a trailing `/**` gets a warning: it doesn't name one directory, so its reads still need approval.

Prefer exact commands to prefixes, and never pre-approve a runner that executes arbitrary scripts (`Bash(npx:*)`, `Bash(node:*)`). The validator accepts those today, so the choice is yours ([security.md S5](security.md)).

## 9. Customizing the team for a project

A project tunes any prompt with files in `<cwd>/.claude/dev-team/`. They apply on top of the profile. `<name>` is a role (including roles the profile adds, such as `web-engineer`), `orchestrator` (the manager) or `team` (the conventions every specialist shares).

| File                  | Effect                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `<name>.md`           | Appended to the prompt, under `## Instructions from this project` (`## Conventions from this project` for `team`). |
| `<name>.<section>.md` | Replaces one `<section>` of the prompt, e.g. `qa-tester.output_format.md`.                                         |
| `<name>.replace.md`   | Replaces the whole prompt, including the profile's material.                                                       |

Sections you can replace:

| Prompt                                                                            | Sections                                                                                                                                                                                           |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orchestrator`                                                                    | `role`, `team` (holds `{{roster}}`), `workflow`, `delegation_brief`, `quality_bar`, `safety`, `output_format`, `verification`, plus `project` and `project_routing` when the profile adds material |
| `team`                                                                            | `handoff`, `repository`, `test_first`, `safety`, `report_format`                                                                                                                                   |
| product-manager, architect, ux-designer, monetization-expert, business-strategist | `role`, `standards`, `output_format`, `verification`                                                                                                                                               |
| backend-engineer, frontend-engineer, mobile-developer, database-specialist        | `role`, `standards`, `workflow`, `output_format`, `verification`                                                                                                                                   |
| qa-tester                                                                         | `role`, `approach`, `test_first_brief`, `output_format`, `verification`                                                                                                                            |
| code-reviewer                                                                     | `role`, `output_format`, `verification`                                                                                                                                                            |

Every role also has `project` when its profile adds material. A profile that sets a role's `core` removes its `<workflow>`, so that section can't then be replaced.

**How a specialist's prompt is assembled**, in order:

1. The built-in prompt.
2. The profile's overlay of it, plus a `<project>` section with the profile's material.
3. This project's `<name>.replace.md` or `<name>.<section>.md`.
4. The shared team conventions, with this project's `team.*` files applied.
5. This project's `<name>.md`, last.

**Rules the loader enforces** (a broken file stops the run with exit 2, and `--roles` shows the same error):

- **Symlinks:** not followed, and refused.
- **Unknown names:** a name that isn't a prompt is refused, with the list of valid names.
- **Empty files:** refused.
- **Missing sections:** a section the prompt doesn't have is refused, with the list of sections it does have.
- **Stray closing tags:** a replacement that contains its own closing tag is refused.
- **Ignored files:** dotfiles, `README.md` and subdirectories.
- **`{{roster}}`:** a replacement of the manager's prompt, or of its `<team>` section, must keep it. In manager section overrides, `{{roster}}` is the only placeholder filled; other braces stay literal.

## 10. The project's own agents

The run loads the target's `.claude` tree, including its agents in `.claude/agents/**/*.md`. The manager may delegate to one when its description fits better than the team's roster. Agents that declare a `model:` keep it.

An agent is skipped, with a warning, when:

- its frontmatter or `name` is missing, or the name is invalid;
- it is unreadable, or a symlink pointing outside `.claude/agents`;
- its name duplicates another agent, or is reserved (`manager`, `unknown`);
- its name is a Claude Code built-in (`general-purpose`, `Explore`, `Plan` and similar).

An agent named like a team role is skipped too, and the team's own definition is used. That is a **notice** when the profile lists the name in `shadowedProjectAgents` (recovery-platform does, for its `product-manager`), and a **warning** otherwise.

Warnings count for `--strict`; notices don't. `--roles` lists the accepted agents and prints the rest. A single unreadable agent file is a warning, but an unreadable `.claude/agents` directory stops the run (exit 2).

## 11. Committing and pushing a run: `--publish`

`--publish` turns a finished `--output json` run into a branch on GitHub, with no model involved:

```bash
GITHUB_TOKEN=… pnpm start --publish result.json --branch hco/42-export --cwd ../recovery-platform
```

What it does:

1. **It checks that the run should be published.** Only `done` runs are published; add `--include-partial` for `partial`. A failed run, any other outcome, or no changes is skipped (exit 4).
2. **It refuses unsafe targets.** It never publishes to `main`, `master` or the remote's default branch (read from the local `refs/remotes/<remote>/HEAD`; when that ref is missing, only `main` and `master` are guarded), refuses a branch name git wouldn't accept, and won't commit any file that looks like it holds secrets.
3. **It commits.** Every uncommitted change in the repository is committed on `--branch`. That includes files outside `--cwd`, and edits made before the run, not only `team.changed_files`. Start from a clean checkout. The one-line subject is `--message <text>`, else `team.commit_message`, else `chore: changes from software-dev-team run <session>`. The body names the session, the outcome and the acceptance tests.
4. **It runs the repository's own commit and pre-push hooks.** So its gates apply, but the hooks never see the token. If a hook rejects the commit or push, nothing is pushed.
5. **It pushes.** `HEAD` goes to `refs/heads/<branch>` on `--remote` (default `origin`), never with force.

An `https://github.com/` remote is authenticated with `GITHUB_TOKEN` (or `GH_TOKEN`), sent as an HTTP header through git's environment, never on a command line. Give that token to this step only, never to a team run.

It prints one JSON object (`{"type":"publish","status":"pushed|skipped|failed","reason",…}`) and exits 0 (pushed), 4 (skipped: not `done`, or nothing to commit), 1 (failed, including a refused branch or a secret file) or 2 (bad arguments; stdout still says `failed`). A failure after the commit, such as a pre-push hook rejecting it or the push failing, leaves the checkout on `--branch` with the local commit, and reports that commit. The result file path is relative to where you run the command, not to `--cwd`.

## 12. Command reference

The help text (`pnpm start --help`) is the source; this table summarizes it.

| Command                                                             | Does                                                             |
| ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `pnpm start "<task>"`                                               | Run the team on a task.                                          |
| `pnpm start --file ./task.md`                                       | Read the task from a file. Can't be combined with task text.     |
| `pnpm start --resume <id> "<answer>"`                               | Continue a session. Needs a message.                             |
| `pnpm start --roles [--cwd <path>] [--profile …]`                   | List the team that would run, checking customizations, and exit. |
| `pnpm start --profiles`                                             | List the built-in profiles and exit.                             |
| `pnpm start --publish <result.json> --branch <name> [--cwd <path>]` | Commit and push a finished run.                                  |
| `pnpm start` with no task, or `--help`                              | Print the help.                                                  |

| Option                                                                        | Default                  | Notes                                                                              |
| ----------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------- |
| `--cwd <path>`                                                                | current directory        | The project the team works in. Must be a directory.                                |
| `--profile <id\|path>`                                                        | detected, else `generic` | Built-in id or profile module path.                                                |
| `--file <path>`                                                               | none                     | The task file. Its contents are trimmed; an empty file is an error.                |
| `-y`, `--yes`                                                                 | off                      | Unattended ([§4](#4-interactive-and-unattended-runs)).                             |
| `--allow <rule>`                                                              | none                     | Repeatable ([§8](#8-pre-approving-commands---allow)).                              |
| `--resume <id>`                                                               | none                     | The session id a run printed.                                                      |
| `--output <text\|json>`                                                       | `text`                   | Only the two-word form: `--output json`.                                           |
| `--strict`                                                                    | off                      | Exit 3 when something needs a check.                                               |
| `--max-turns <n>`                                                             | 60                       | A positive integer; the manager's cap.                                             |
| `--max-budget <usd>`                                                          | none                     | A positive number such as `5` or `2.50` (`.5` and `1.` are rejected).              |
| `--model <name>`                                                              | the SDK's default        | The manager's model (e.g. `opus`, `sonnet`). Specialists keep their pinned models. |
| `--verbose`                                                                   | off                      | Show tool results in the trace.                                                    |
| `--branch <name>`, `--remote <name>`, `--include-partial`, `--message <text>` | `--remote origin`        | `--publish` only.                                                                  |

Two parsing rules catch people out:

- A flag's value can't start with `-`.
- Neither can task text: an argument starting with `-` is read as an unknown option. Put such a task in a file and use `--file`.

## 13. Environment variables

| Variable                                       | Read by           | Effect                                                                                                                                                                                                                                                                              |
| ---------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` | the SDK           | The model credential. The CLI only checks whether either is set, to print the stored-credentials notice.                                                                                                                                                                            |
| `GITHUB_TOKEN`, `GH_TOKEN`                     | `--publish`       | The push token for an https GitHub remote. `GITHUB_TOKEN` wins. Never seen by the repository's hooks.                                                                                                                                                                               |
| `GIT_AUTHOR_EMAIL`                             | `--publish`       | When it and `git config user.email` are both unset, publish commits as `software-dev-team <software-dev-team@users.noreply.github.com>`.                                                                                                                                            |
| `DEBUG`                                        | startup           | Print the stack trace of a configuration error raised while preparing the run (an unknown customization file, a missing `{{roster}}`, an invalid profile allow rule) instead of just its message. Argument and profile-resolution errors always print only the message.             |
| Anything named like a credential               | the safety policy | Any variable whose name contains, in any case, `API_KEY` / `APIKEY`, `TOKEN`, `SECRET`, `PASSWORD` / `PASSWD`, `PRIVATE_KEY` or `CREDENTIAL(S)`, with a value of 12+ characters. A tool call that contains one of these values is blocked, and the value is redacted in the ledger. |

The whole environment is passed to the SDK, plus `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1`, which keeps Claude Code's built-in agents off the manager's menu.

## 14. Troubleshooting

| Symptom                                                             | Cause and fix                                                                                                                                          |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The help prints and nothing runs                                    | No task was given. Pass task text or `--file`.                                                                                                         |
| `Unknown option: -…` for your task                                  | The task text starts with `-`. Use `--file`.                                                                                                           |
| `<flag> requires a value`                                           | The value is missing or starts with `-`.                                                                                                               |
| `No TTY available for approval prompts`                             | A non-interactive shell without `--yes`. Add `--yes`, or run in a terminal.                                                                            |
| `Profile "regroup" gives paths relative to the project root …`      | `--cwd` is inside a product directory. Use the `--cwd <root> --profile <id>` it prints.                                                                |
| `… does not match a prompt. Name it <name>.md …`                    | A `.claude/dev-team/` file with an unknown name. Rename it to one of the names listed.                                                                 |
| `… has no <x> section to replace`                                   | That role's prompt has no such section, or a profile `core` removed `<workflow>`. See [§9](#9-customizing-the-team-for-a-project).                     |
| `The orchestrator prompt must include {{roster}}`                   | A manager replacement dropped the placeholder.                                                                                                         |
| `Allow rule … would grant every … call` / `… can never take effect` | An `--allow` rule the validator rejects ([§8](#8-pre-approving-commands---allow)).                                                                     |
| `Blocked by the team's safety policy (…)` in the trace              | A call the safety layer refuses whatever the rules say. The manager reports it for you to run yourself if it's needed.                                 |
| A command you expected to run is refused under `--yes`              | No allow rule names it. Add an exact `--allow` rule, or a profile `allow` entry ([extending.md §6](extending.md#6-pre-approving-a-projects-commands)). |
| Exit 3 with `--strict`                                              | Read the warning and the ledger: a call failed, was blocked or refused, ran in the background, or never finished; or configuration was rejected.       |
| A startup error with no detail                                      | Re-run with `DEBUG=1` for the stack trace (configuration errors raised while preparing the run).                                                       |
