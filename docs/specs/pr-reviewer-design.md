# Repo-aware PR reviewer for software-dev-team: design

**Date:** 2026-10-26 · **Status:** approved at the phase 3 checkpoint, implemented on `chore/pr-review` (not pushed) · **Owner:** Marcus Klein

The understanding behind this design is in `docs/reports/pr-reviewer-project-brief.md` ("brief §n"). The reference design is recovery-platform's `docs/superpowers/specs/2026-10-22-pr-review-agent-design.md` ("RP §n"). The shared engine is `marcusk639/pr-review-kit` ("kit"). Its `docs/design.md` defines the configuration surface used below. The implementation plan is `docs/plans/pr-reviewer.md`, and the GitHub steps are in `docs/plans/pr-reviewer-runbook.md`.

## 1. Intent

This repo is a safety harness for autonomous agents. Most of its value is a pattern-matching policy, and its own reviewers needed four review rounds to close the bypasses they found in it (brief §4, C1–C5). Marcus already runs several local reviewer agents on every PR. A GitHub reviewer adds value only where those local passes are structurally weak:

- **String links that typecheck can't see.** Prompts, code, tests, help text, consumers' customization files and SDK behaviour all depend on each other by name (brief §3, L1–L15).
- **Loosenings.** Any change that lets through an input that used to be denied must be named and justified (L15, C10, C12).
- **PR-text accuracy.** PR bodies here are long and make specific claims: test counts, "verified live", lists of intentional loosenings, merge instructions (C11).
- **An independent pass on carve-outs** (C2), the class that cost the most review rounds.

## 2. Decisions (Marcus, phase 3 checkpoint)

| Decision                | Choice                                                                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Effect on merging       | Advisory only. It comments, and never approves, blocks or becomes a required check.                                                                               |
| Runtime, auth and model | The kit's composite actions on `claude-code-action`, with `CLAUDE_CODE_OAUTH_TOKEN` and Opus. The kit is public and pinned by full SHA.                           |
| Security findings (Q1)  | Safety-hook bypass findings stay private: a public pointer plus a draft advisory. The pointer may name a fixed policy area, never the input.                      |
| Stacked PRs (Q2)        | Only PRs whose base is `main` are reviewed, using a workflow branch filter and a `base.ref` guard (the pattern the engine endorses). Loading rules from `main` for other bases (`trustRef`) stays out. |
| CI (Q3)                 | A minimal `pnpm typecheck && pnpm test` workflow is separate follow-up work.                                                                                      |
| Merge style (Q4)        | Merge commits stay, so commit subjects are what reach `main`.                                                                                                     |
| Lessons (Q5)            | No auto-merge. Every lesson comes in the weekly learning PR.                                                                                                      |
| Renames (Q6)            | A role or section rename is Medium, since no consumers of `.claude/dev-team/` are known.                                                                          |
| Inline cap (Q7)         | 5.                                                                                                                                                                |
| Feedback                | Only the repo owner's (`marcusk639`) reactions count, plus replies whose first non-quoted line starts with `review:`. Edited comments are ignored.                |
## 3. Goals

- **G1. Cross-artifact break detection.** For each link type the diff touches (L1–L15), open the other side and report concrete drift, citing both sides.
- **G2. Operator-promise impact.** Name the promise a change puts at risk: safety, role boundaries, honest evidence, prompt customization, or the CLI contract (brief §1). This replaces recovery-platform's "features at risk".
- **G3. Loosening audit.** Every deny→allow change, in rules or in tests, must be named in the PR text as intentional, or it is a finding.
- **G4. Repo-specific classes** C1–C12, routed by path (§7.3).
- **G5. PR-text accuracy.** Claims about tests, live verification, known gaps and merge style are checked against the diff and the commit list.
- **G6. Signal over volume.** It posts few findings, does no generic review, and doesn't re-raise what the PR body already dispositions.

## 4. Non-goals

- Running code: no `pnpm install`, typecheck or tests. The repo has no CI. Adding one (`pnpm typecheck && pnpm test`) is a separate follow-up (§12), and the reviewer must not pretend to have run anything.
- Generic code review. Marcus's local reviewer agents already do that, and so does the team's own `code-reviewer` role.
- Proving the safety policy sound. The reviewer looks for regressions and unflagged loosenings in a diff. It is not a fuzzer, and it doesn't hunt for new bypasses in code the PR doesn't touch.
- Reviewing forks, Dependabot, or drafts.

## 5. Anti-goals (failure even if it "works")

All of RP §5 applies. These matter most here:

- **Publishing a working bypass.** A concrete input that gets past the hook, posted on a public PR, arms anyone who can get text in front of an unattended team. This applies to the summary, inline comments, the hidden ledger, the job log, and learned memory.
- **Re-reviewing what five local agents already reviewed.** Restating the diff, style nits, or "consider adding a test" on a PR that adds 300 tests.
- **Calling a carve-out safe because the tests pass.** The tests are written by the same author as the rule.
- **Treating `prompt.md`/`SKILL.md` edits as docs.** In this repo they are behaviour (L6, L7, L14).

## 6. Constraints

- The repo is public. `marcusk639` is the only collaborator (brief §7).
- There is no `.claude/settings.json`, `.mcp.json`, root `CLAUDE.md` or `AGENTS.md` today. A PR could add any of them, so the engine's review action must neutralize PR-head agent config, disable hooks, pass `--strict-mcp-config` and `--setting-sources user`, and deny `Skill` and reads of `.claude-pr/`. These are mandatory engine properties (§9).
- PRs land as merge commits, not squashes. Commit subjects reach `main` and the PR title doesn't, so the reviewer checks commit subjects (`OUT/commits.txt`) and the kit's `titleScope` check is off.
- There is no file-size rule, so the kit's `newFileSize` check is off.
- The reviewer's scripts use Node built-ins only. The repo's own toolchain (pnpm, tsx, TypeScript 7) is never installed in the review job, and none of the code under review runs there. The base branch's `.pr-review/checks/*.mjs` modules do run in the facts step. From kit `fb07975` (P0.1) each runs in an isolated child process with a PATH-only environment (no `GH_TOKEN`), an empty working directory and a 20-second kill timeout, using only `ctx.git` (run as `git -C <repo>` with no user or system config), `ctx.mergeBase` and the read helpers. They are trusted like the knowledge, because they come from the trust SHA, never the PR head.
- `id-token: write` and `pull-requests: write` are job-level permissions, so they apply to every step of the review job, facts included, not only to the review or publish step.
- **Accepted exposure: a same-repo PR can rewrite the workflow.** `pull_request` runs the workflow file from the PR head, so a branch pushed to this repo can edit `pr-review.yml` and send the review job's secrets (`CLAUDE_CODE_OAUTH_TOKEN`, `PR_REVIEW_ID_KEY`, `SECURITY_ADVISORY_TOKEN`) anywhere. This is the same gap recovery-platform accepted (RP §10): forks get no secrets, and Marcus is the only collaborator. But the agents that push branches here run with Marcus's credentials, so an agent steered by content it read could make such an edit. The self-edit High finding flags any change to the workflow, and a required-reviewer environment was rejected because it would gate every review on Marcus. **Rotate all three secrets after any suspicious PR**, or any PR that edits `.github/workflows/pr-review*.yml` in a way you didn't intend.

## 7. Design

### 7.1 Workflows

- **`.github/workflows/pr-review.yml`** is the kit's example workflow with these local changes:
  - `on.pull_request.branches: [main]`, plus a `github.event.pull_request.base.ref == 'main'` job guard, which covers a PR retargeted after it was opened (Q2)
  - `actions/checkout` pinned to the `v4.4.0` commit SHA
  - the kit's `review` and `publish` actions pinned to one full SHA
  - a 30-minute timeout
  - `closed` in the trigger types, with the kit's guard `(github.event.action != 'closed' || github.event.pull_request.merged)`: a merged PR gets one last look if its final head was never reviewed (tier `none` otherwise), and a PR closed without merging is skipped

  Everything else is adopted from RP §7.1 through the kit:
  - triggers, concurrency and permissions
  - the same-repo, draft and Dependabot guards
  - facts, then the model, then a model-free publish
  - secrets passed only to the step that needs them

- **`.github/workflows/pr-review-learn.yml`** is the kit's learning workflow, weekly plus manual dispatch, with the same SHA pins. The `learn` job holds the Claude token and no write token. The `propose` job holds the write token and no model. Lessons reach the reviewer only when Marcus merges the learning PR.

### 7.2 Project files (`.pr-review/`, read from the trust SHA)

The kit reads everything below from the PR's `base.sha` and replaces the working-tree copy from it before the model runs. A PR's edits to `.pr-review/` are visible to the model only in `pr.diff`.


| File                                                                   | Contents                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.json`                                                          | The kit config: public with the `advisory` channel, classes 1–12 (1–5 security, 11 `always` and `light`), tiers, `inline.max: 5`, checks, `trust.feedbackAuthors: ["repository-owner"]`, `lightExclude`, classes 1–5 `protected`, `secrets.allowPatterns` for test fixtures, `checks.writeCollaborators` (owner only), `learning.commands`.                                         |
| `REVIEW.md`                                                            | The addendum: operator promises instead of features, the cross-artifact pass, behavioural markdown as code, the loosening audit, the security boundary and its area vocabulary, large-PR priorities, severity calibration. |
| `routing.json`                                                         | 16 link types: L1–L15 from brief §3 plus `review-config`. Each maps paths to counterparts and classes.                                                                                                                     |
| `checklist.md`                                                         | Classes 1–12 (brief C1–C12): what to look for, trigger paths, evidence as commits and PRs only.                                                                                                                            |
| `contract-map.md`                                                      | One `## <linkType>` section per routing entry. Patterns and counterpart paths only.                                                                                                                                        |
| `conventions.md`, `false-positives.md`                                 | Brief §5 and §6. `false-positives.md` is seeded with the rulings in brief §9, each with its source.                                                                                                                        |
| `learned-lessons.md`, `learned/lessons.json`, `learned/precision.json` | Learned memory, seeded empty: no reviewer corrections exist on GitHub (brief §9).                                                                                                                                          |
| `checks/policy.mjs`, `checks/contracts.mjs`, `checks/lib/`             | Project checks (§7.4), with tests under `checks/test/`.                                                                                                                                                                    |

Every map entry was re-verified against `main` when written, and the kit's `validate` checks that every backticked path exists. The map is guidance, not truth, and adding "map maintenance" notes is part of the procedure (adopted from RP §7.2).

### 7.3 Routing

`routing.json` holds the authoritative table. In summary:

| Paths touched                                                    | Link types                                                                | Classes                  |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------ |
| `src/permissions.ts`, `src/permissions/**`, policy test suites   | policy-tests, protected-paths, secret-families, tool-names                | 1–5, 10, 12              |
| `src/allowlist.ts`                                               | allow-rule-syntax, tool-names, policy-tests                               | 2, 3, 4, 5, 8, 9, 10, 12 |
| `src/tools.ts`, `src/agents/**/index.ts`, `src/agents/shared.ts` | tool-names, role-registry, plugin-skills                                  | 4, 5, 7, 8, 9            |
| `src/team.ts`, `src/project-agents.ts`                           | role-registry, sdk-assumptions, reserved-names                            | 4, 6, 7, 8, 9            |
| `src/**/prompt.md`, `plugin/**`, `src/prompts.ts`                | prompt-sections, placeholders, prompt-bytes, report-status, plugin-skills | 7, 8                     |
| `src/ledger.ts`, `src/outcome.ts`, `src/orchestrator/summary.ts` | ledger-text, cli-surface, reserved-names, secret-families                 | 1, 2, 4, 5, 6, 7, 8      |
| `src/cli.ts`, `src/index.ts`                                     | cli-surface                                                               | 6, 7, 8                  |
| `package.json`, `src/orchestrator/index.ts`                      | sdk-assumptions, placeholders                                             | 4, 8, 9                  |
| `.prettierrc`, `.prettierignore`, `.gitattributes`               | prompt-bytes                                                              | 7                        |
| `.pr-review/**`, the two workflows                        | review-config                                                             | 11 (and self-edit High)  |
| anything                                                         |                                                                           | 11 (always)              |

Classes 1–5 are security classes. Class 9 is security-relevant when a safety rule depends on the assumption (addendum).

### 7.4 Deterministic facts

The kit's generic facts are adopted: changed files, packages, link types, the secret scan, self-edit and engine pin. PII-in-logs, new-file size, title scope and verify-diff are off. The project checks are hints the model must confirm, never verdicts:

| Check              | Module                 | What it reports                                                                                                                                                                                                                                |
| ------------------ | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy-loosening` | `checks/policy.mjs`    | Compares the `denies`, `allows`, `check` and accepted-false-positive tables of every policy test suite at the merge base and at the head, across files (at most 40 suites, each under 256 KB). Reports deny→allow moves, deny cases removed with no replacement, and new allow cases, as counts and `file:line` ranges only, never the case text, since a loosened case may be a working bypass. Notes stay under the kit's 300-character cap; the addendum's "Project facts" section says what each one means. Suites without case tables (loops, plain `it()`) produce nothing, and that silence is not coverage. |
| `carve-outs`       | `checks/policy.mjs`    | Added lines in the policy that look like an exemption (`return null`, `exempt`, `strip`, `skip`, `except`, `bypass`, `SAFE_`/`NO_OP_` names), one fact per file.                                                                               |
| `role-names`       | `checks/contracts.mjs` | `AGENTS` keys removed (and the prompts that still name them) or added (and named in no prompt).                                                                                                                                                |
| `prompt-sections`  | `checks/contracts.mjs` | Section tags removed (marked consumer-breaking) or added in a `prompt.md`.                                                                                                                                                                     |
| `sdk-pin`          | `checks/contracts.mjs` | A change to the SDK version, and the files that still name the old one.                                                                                                                                                                        |
| `tool-lists`       | `checks/contracts.mjs` | Membership changes in `ToolName` and the tool lists in `src/tools.ts`, `src/agents/shared.ts` and `src/permissions.ts`.                                                                                                                        |

**Secret-scan fixtures.** `secrets.allowPatterns` skips the fake `sk-ant-test-<hex>` credentials the policy tests use (`^sk-ant-test-[0-9a-f]{8,32}$`, matched against the secret text only, so a real key in a test file is still flagged; real Anthropic keys never have the `sk-ant-test-` prefix). Verified on `8746b35`: one `secrets` fact without the pattern, none with it.

### 7.5 Tiers

The kit's tiers are kept, with lower caps: `full` 60, `incremental-new-links` 45, `incremental` 25, `light` 10, `base-drift` 10. The draft dropped `light` and `base-drift`. The kit can't disable single tiers, and neither tier causes harm:

- A prompt or skill edit is never `light`, because those paths trigger link types and light applies only to an increment with no link types.
- `lightFiles` is narrowed to `docs/**`, images, `.txt` and the lockfile, and `lightExclude` (`src/**/prompt.md`, `plugin/**`) makes behavioural markdown never light, even without a routed link type.

The large-PR threshold is 60 files or 6,000 lines. The kit counts test lines too, so the addendum orders the reading for large PRs: facts first, then policy sources, then wiring and the ledger, then prompts, with tests last.

### 7.6 Security findings

Adopted from RP §7.8–7.9: the public pointer, draft repository advisories (available on public repos), a model with no advisory token, and opaque ledger IDs keyed with `PR_REVIEW_ID_KEY`.

What counts as security-relevant here:

- classes 1–5
- any input or sequence that the hook, the delegation guard or read confinement would let through
- a path that exposes a secret value
- a fail-open
- an undeclared loosening of a deny rule

The pointer's `package` is `src`, `plugin` or `repo`. Its `area` must come from a fixed list: `shell rules`, `git rules`, `path confinement`, `secret families`, `delegation guard`, `allow rules`, `hook wiring`, `ledger`. A loosening that the PR declares, with a reason, is not a security finding by itself, and the `## Loosenings` table names only its rule family.

### 7.7 Output

Adopted from RP §7.7 through the kit: the sticky summary with its hidden ledger, fingerprinted inline comments, publish-side guards, redaction, and "partial" or "incomplete" never shown as clean. Local changes:

- `## Promises touched` replaces "Features touched".
- `## Cross-artifact impact` replaces "Cross-package impact".
- `## Loosenings` is added (change, declared, where).
- The inline cap is 5.

### 7.8 Learning from Marcus's feedback

Adopted from the kit (kit design §5), with these settings:

- **Trusted:** the repository owner only (`trust.feedbackAuthors: ["repository-owner"]`, resolved at runtime to `marcusk639`). That means his 👍/👎 and his replies that start with `review:`. Edited comments, other accounts and bots don't count.
- **Destinations:** lessons go into the managed blocks of `false-positives.md`, `conventions.md`, `checklist.md` and `contract-map.md` first, then `learned-lessons.md`.
- **Protected:** classes 1–5 are security classes, so a 👎 never demotes them, and any lesson that narrows them is flagged for Marcus's decision.
- **Security feedback:** feedback on security findings lives in the advisories and becomes memory only as a pattern Marcus writes himself.
- **Merge:** no auto-merge. There is one weekly learning PR, with no PAT or dispatched CI on it. It has no author or branch exemption from the self-edit finding: the kit (from `74c155b`) replaces that finding with a `learning-pr` fact only when every commit is by `github-actions[bot]` and every change stays inside the managed blocks and `learned/*.json`. Anything else still gets the High self-edit finding.
- **Learn-job commands:** `format` runs `npx --yes prettier@3.9.10 --write {files}` (the version Marcus's local format-on-edit hook uses, so learning-PR markdown matches hand edits), and `validate` runs the project-check tests. If either fails, nothing is proposed.
- **Formatting:** the repo has no formatter or doc checks of its own (Prettier runs only through Marcus's local hook), so the learn job has nothing project-specific to run beyond the kit's own validation.
- **Seed:** learned memory starts empty, and the rulings already made are in `false-positives.md`.

### 7.9 Delivery order

See `docs/plans/pr-reviewer-runbook.md`. The order is: skeleton PR, merge, secrets and settings, test PR, replay PRs with planted, clearly labelled bugs, a feedback round trip, then a trial. This follows RP §7.10, since the engine and knowledge must be on `main` before they review anything.

## 8. Acceptance criteria (from RP §8, adapted)

1. The skeleton posts with zero permission denials.
2. The replay set (runbook) is flagged with the correct other side.
3. A clean PR, such as a docs-only change under `docs/prompts/`, produces no Critical or High findings.
4. Hooks, MCP servers and PR-head agent config demonstrably don't load.
5. Forks and drafts are skipped, and so are PRs whose base isn't `main`.
6. A run on a PR the size of #4 (4k lines, 41 files) finishes within its caps, and the observed turns and duration are reported.
7. Incremental runs: a fix push and a docs push pick the expected tiers, with no re-posts.
8. A planted security finding leaks nothing beyond severity, package and area, anywhere public.
9. The feedback round trip changes behaviour on the next PR.
10. Trial: Marcus reacts to every finding for two weeks or ten PRs, whichever is first. The target is at least 70% 👍 and no wrong Critical or High finding.

## 9. What the engine provides

Mandatory security properties, inside the kit's actions. They were requested on 2026-10-26 and landed in the kit's P0 commit `be671da`. Both workflows now pin `fb07975` (P1, P2 and P0.1). `validate` now requires them:

- `--setting-sources user`
- `Skill` and `Read(./.claude-pr/**)` disallowed
- a neutralize-PR-head step (root `CLAUDE.md`/`AGENTS.md`, `.ignore`/`.rgignore`)
- third-party actions pinned by SHA
- one trust SHA (the PR's `base.sha`) for facts, the model's copy of the knowledge and publish. The kit moved project files to a root `.pr-review/` for this, so the action's `.claude/` restore from the base branch tip can't swap them (engine decision, 2026-10-26)
- `validate` checks for these properties

Still open (not in `fb07975`). Until they land, project checks and the addendum stand in for them:

- P0.2: fixes for the learning-PR bot-identity spoof (git author name) and for withheld globs being dropped, plus four Medium issues. **A precondition for enabling the reviewer** (runbook step 0).

- a test-excluding size measure for `largePr`
- a summary "Loosenings" section and a commit-subject convention target (the addendum covers both)

## 10. Adopted, adapted, dropped

| recovery-platform element                                      | Here                      | Why                                                                                                |
| -------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------- |
| Advisory only, never blocking                                  | Adopted                   | Marcus weighs the findings.                                                                        |
| Base-branch knowledge and scripts                              | **Adapted**               | Kept, and PRs whose base isn't `main` are skipped, because stacked PRs are normal here (#1→#2→#3). |
| Sandboxed model, model-free publish                            | Adopted                   | It reads untrusted PR text in a public repo.                                                       |
| Hooks off, strict MCP config                                   | Adopted, and strengthened | Plus user-only setting sources and PR-head agent-config neutralization (kit).                      |
| Cross-package pass and contract maps                           | **Adapted**               | A cross-artifact pass over the string links L1–L15.                                                |
| Feature-impact pass                                            | **Adapted**               | Operator promises. There are no end-user features.                                                 |
| The 14-class checklist                                         | **Replaced**              | Classes 1–12, mined from this repo.                                                                |
| Firestore, callable, region and index checks; `verify-diff.sh` | Dropped                   | They don't exist here. The project checks in §7.4 replace them.                                    |
| 300-line rule, PII-in-logs, title scope                        | Dropped                   | No size rule, no PII domain, and merge commits.                                                    |
| Secret scan                                                    | Adopted                   | Fixture false positives are handled in `false-positives.md`.                                       |
| Tiers                                                          | **Adapted**               | All kept, with lower caps and narrowed `lightFiles`.                                               |
| Ledger, fingerprints, sticky summary                           | Adopted                   | Kit-owned.                                                                                         |
| Inline cap of 10                                               | **Adapted**               | 5, because PRs arrive already reviewed.                                                            |
| Public pointer and draft advisory                              | **Adapted**               | Kept, with a fixed area vocabulary.                                                                |
| Self-edit High finding                                         | Adopted                   | `pull_request` runs the PR's own workflow file. It applies to the learning PR too.                 |
| Accepted gap: a PR can edit its own workflow                   | Adopted, documented       | One collaborator, forks excluded. Agents push with Marcus's credentials, so: rotate secrets after a suspicious PR (§6). |
| `e2e-fix/*` skip                                               | Dropped                   | There are no such branches.                                                                        |
| Replay set and two-week trial                                  | **Adapted**               | Repo-specific replays, and the trial is also bounded by PR count.                                  |
| Feedback learning                                              | Adopted (new)             | Owner only, `review:` replies, no auto-merge.                                                      |

## 11. Local verification (2026-10-26)

- The project-check tests pass: `node --test '.pr-review/checks/test/*.test.mjs'` gives 38/38. That includes a hostile-input timing test and the 256 KB size cap.
- The kit's `validate` reports ok, and `actionlint` is clean on both workflows.
- **Historical dry runs** (kit `local` at `fb07975`, knowledge from the working copy, checks running in the kit's isolated child process; earlier runs at `85ab8f9`, `be671da` and `74c155b` gave the same facts, with longer notes):
  - **PR #1** (`747b8a6...09f238e`) routes `role-registry`, `prompt-sections`, `prompt-bytes`, `plugin-skills`, `tool-names`, `cli-surface`, `placeholders` and `sdk-assumptions`. `tool-lists` reports the role tool sets moving to `src/agents/shared.ts`.
  - **PR #5** (`9fe2d03...74ef64e`) routes 14 of the 16 link types and all classes. `policy-loosening` points at 49 new allow cases and finds no deny case moved or removed (that is accurate: PR #5 tightened, and its loosenings were new allow cases). `carve-outs` points at four files.
  - **`36ed855`** (an intentional loosening: no-op git editors and `.env.ts`) gets a `policy-loosening` fact pointing at exactly those ten new allow cases (`src/permissions-round3.test.ts` lines 269–278), which the commit body declares.
  - **`a945089`** (the class-2 historical bug: the message-stripping exemption that was later withdrawn) gets a `policy-loosening` fact pointing at the 12 commit and PR message cases (`src/permissions-round3.test.ts` lines 192 onward) that became allowed. This is the signal that would have pointed a reviewer at the carve-out. `carve-outs` didn't fire here, because the exemption's lines don't use the trigger words, so `policy-loosening` is the stronger of the two.
- **A fixture review** on `a945089`, with a planted security finding and one Medium finding, renders the pointer as "Security-relevant issue (High) in src shell rules". Neither the planted detail nor the anchor appears anywhere in the output or the decoded ledger. Without `PR_REVIEW_ID_KEY` locally, the pointer says the details could not be delivered, as designed.
- **Not verified locally:**
  - anything that needs GitHub (posting, advisories, the learning PR)
  - the model's actual behaviour

## 12. Follow-ups

- Reviewing stacked PRs at all (the engine keeps `trustRef` out; the workflow-level main-only filter is the endorsed pattern).
- A minimal CI workflow for `pnpm typecheck && pnpm test` (Q3).
- A test that cross-checks role names in `src/orchestrator/prompt.md` against `ROLES` (L1, flagged in PR #1).
- Prettier protection for `plugin/**/SKILL.md` if its bytes matter for caching (L14).
