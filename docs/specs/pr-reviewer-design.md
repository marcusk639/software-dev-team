# Repo-aware PR reviewer for software-dev-team: design (draft)

**Date:** 2026-10-26 · **Status:** draft for the phase 3 checkpoint · **Owner:** Marcus Klein

The understanding this design rests on is in `docs/reports/pr-reviewer-project-brief.md`. Section numbers in the form "brief §n" point there. The reference design is recovery-platform's `docs/superpowers/specs/2026-10-22-pr-review-agent-design.md` ("RP §n"). The shared engine (`~/dev/pr-review-kit`) is being extracted in parallel and its interface is not settled, so §9 lists what this project needs from it rather than assuming an API.

## 1. Intent

This repo is a safety harness for autonomous agents. Most of its value is in a pattern-matching policy that has needed four review rounds to close the bypasses its own reviewers found (brief §4, C1–C5). Marcus already runs several local reviewer agents on every PR. A GitHub reviewer adds value only where those local passes are structurally weak:

- **String links that typecheck can't see**: prompts ↔ code ↔ tests ↔ help text ↔ consumers' customization files ↔ SDK behaviour (brief §3, L1–L15).
- **Loosenings.** Any change that lets through an input that used to be denied must be named and justified (L15, C10, C12).
- **PR-text accuracy.** PR bodies here are long and make specific claims: test counts, "verified live", lists of intentional loosenings, merge instructions (C11).
- **An independent pass on carve-outs** (C2), the class that cost the most rounds.

## 2. Decisions this design assumes (Marcus confirms at the checkpoint)

| Decision                 | Proposed                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Effect on merging        | Advisory only. It comments and never approves, blocks or becomes a required check. (Adopted.)                                   |
| Runtime, auth and model  | The shared engine on `anthropics/claude-code-action@v1`, `CLAUDE_CODE_OAUTH_TOKEN`, Opus. (Adopted. The secret is not set yet.) |
| Security findings        | Public pointer and private draft advisory. The pointer may name the policy area, never the input (§7.6). (Adapted.)             |
| Review frequency         | Every push, with no duplicates, using a reduced tier set (§7.5). (Adapted.)                                                     |
| Trusted feedback authors | `marcusk639` only. He is the sole collaborator, and the repo is public. (Adopted.)                                              |

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
- There is no `.claude/settings.json`, no `.mcp.json` and no `CLAUDE.md` today. The workflow still passes `disableAllHooks` and `--strict-mcp-config`, so adding any of them later can't change CI behaviour.
- PRs often target a non-default base. PR #2 was stacked on #1, and PR #3 exists because of it. Knowledge loaded from "the PR's base" would then come from a feature branch an agent can push to (§7.1, open question Q2).
- Merge commits, not squash. Commit subjects reach `main` and the PR title doesn't, so the reviewer checks commit subjects (`OUT/commits.txt`) against the conventional format instead of the PR title.
- There is no file-size rule, so recovery-platform's 300-line check is dropped.
- Node scripts in the reviewer use built-ins only. The repo's own toolchain (pnpm, tsx, TypeScript 7) is never installed in the review job.

## 7. Design

### 7.1 Workflow

The engine's workflow, as a thin caller in `.github/workflows/pr-review.yml` pinned to an engine commit SHA. Triggers, concurrency, permissions, the same-repo/draft/bot guards, the facts → model → publish split, and a publish step that holds secrets and never runs the model are all adopted from RP §7.1. Local deltas:

- **Knowledge source.** Load `.claude/pr-review/` from the head of the default branch (`main`), not from the PR base, whenever the base isn't `main`. A stacked PR must not be judged by rules edited on its parent branch. This needs an engine option (§9, `trustRef`). If Marcus prefers it, the alternative is to skip PRs whose base isn't `main` (Q2).
- **Skip prefixes.** None today (the repo has no `e2e-fix/*`-style agent branches).
- **Timeout.** 30 minutes.

### 7.2 Knowledge files (`.claude/pr-review/`, base-controlled)

| File                 | Contents                                                                                                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REVIEW.addendum.md` | Repo-specific procedure on top of the engine's `REVIEW.md`: the cross-artifact pass, the loosening audit, operator promises instead of features, treating behavioural markdown as code, and the security boundary in §7.6. |
| `contract-map.md`    | One file is enough at this size. A `## <linkType>` section for each of L1–L15, both directions, with counterpart paths. Patterns only.                                                                                     |
| `checklist.md`       | C1–C12 with what to look for, trigger paths and historical evidence (commits and PRs only).                                                                                                                                |
| `conventions.md`     | Brief §5, which in this repo stands in for the `CLAUDE.md` it doesn't have.                                                                                                                                                |
| `false-positives.md` | Brief §6, seeded with the rulings in brief §9, each with its source.                                                                                                                                                       |
| `routing.json`       | Engine schema. Paths → link types → classes → counterparts (§7.3).                                                                                                                                                         |
| `learned.md`         | Learned memory, seeded empty (brief §9). The engine's learning workflow proposes edits to this file and to the four above.                                                                                                 |
| `checks/*.mjs`       | Project fact modules (§7.4), if the engine's extension point allows them.                                                                                                                                                  |

The map is guidance, not truth, and every entry is re-verified against `main` when it is written (adopted from RP §7.2). The "map maintenance" note is adopted too. New link types appear here as the harness grows.

### 7.3 Routing

| Paths touched                                                    | Link types                       | Classes              |
| ---------------------------------------------------------------- | -------------------------------- | -------------------- |
| `src/permissions.ts`, `src/permissions/**`                       | L5, L8, L9, L15                  | C1–C5, C10, C12      |
| `src/allowlist.ts`                                               | L5, L11, L15                     | C3, C5, C8, C10, C12 |
| `src/tools.ts`, `src/agents/shared.ts`, `src/agents/*/index.ts`  | L1, L4, L5                       | C5, C7, C8           |
| `src/team.ts`, `src/project-agents.ts`                           | L1, L13                          | C8, C9               |
| `src/**/prompt.md`, `plugin/**`                                  | L1, L2, L3, L6, L7, L8, L10, L14 | C7                   |
| `src/prompts.ts`                                                 | L2, L3, L14                      | C8                   |
| `src/ledger.ts`, `src/outcome.ts`, `src/orchestrator/summary.ts` | L6, L10, L13                     | C6                   |
| `src/orchestrator/index.ts`                                      | L3, L5, L12                      | C4, C6, C9           |
| `src/cli.ts`, `src/index.ts`                                     | L10, L11                         | C7, C8               |
| `package.json`, `pnpm-lock.yaml`                                 | L12                              | C9                   |
| `src/**/*.test.ts`                                               | L15                              | C10, C12             |
| `.prettierrc`, `.prettierignore`, `.gitattributes`               | L14                              | C7                   |
| `docs/**`                                                        | none                             | C11 only             |
| any                                                              | none                             | C11 always           |

Security classes for §7.6 are C1–C5 always, plus C9 when the assumption is one a safety rule depends on.

### 7.4 Deterministic facts

The engine's generic facts are adopted: changed files by area, link types triggered, secret scan of added lines, commit list, and size. These are project-specific hints the reviewer must confirm, never verdicts:

1. **Policy-test movement (L15).** For `src/permissions*.test.ts` and `src/allowlist.test.ts`, list string literals removed from a `denies(`-style case or deny list and added under `allows(` or an accepted list, plus the counts of removed and added deny cases. This is the loosening signal G3 needs.
2. **Role names (L1).** If `AGENTS` keys in `src/team.ts` change, list every prompt file that names an old or new key.
3. **Prompt sections (L2).** Section tags added, removed or renamed in any `prompt.md` are marked "consumer-breaking".
4. **SDK bump (L12).** If the SDK version in `package.json` changes, list the files that carry `0.3.283` or "unverified" comments.
5. **Tool union (L5).** Changes to `ToolName`, `WRITE_TOOLS`, `MANAGER_ALLOWED` or role tool sets.
6. **New exemptions (C2).** Added lines in `src/permissions/**` that look like carve-outs (`return null` in a deny function, `allow`/`exempt`/`skip`/`strip` identifiers, new entries in `*_ONLY`/`SAFE_*`/`NO_OP_*` sets). This is a hint for where to look first, and its noise level gets checked in the dry run.
7. **Behavioural markdown.** `src/**/prompt.md` and `plugin/**/SKILL.md` count as code for tiering, and the diff of them is surfaced in full.

**Secret scan.** Allow-list the fixture values in `src/**/*.test.ts` (`sk-ant-test-…`, `ghp_0123456789ab`) so they don't drown the facts file, but keep scanning everything else. Drop recovery-platform's PII-in-log heuristics, since there is no PII domain here.

### 7.5 Tiers

- **Adopted:** `none` (empty increment), `full` (first run, rewritten history, or no prior state), `incremental` (the increment's hunks plus the counterparts of the link types it touches).
- **Dropped:** `light` (docs-only). Here the "docs" that matter are prompts, and the rest of `docs/` is snapshot reports. A `docs/**`-only increment gets `incremental` with a low cap, which is cheap enough.
- **Dropped:** `base-drift`. PRs live for hours, there is one author, and the string links all point inside this repo, so `main` changing a counterpart under an open PR is rare. A merge from `main` is reviewed as `incremental`.
- **Turn caps:** `full` 60 and `incremental` 25. Calibrate on the replay set, since PR #4 (4k lines, 41 files) is the worst historical case.
- **Large-PR rule.** Count lines without `src/**/*.test.ts` and `pnpm-lock.yaml`, since tests are about half of every large PR. Over the threshold, prioritise `src/permissions/**`, `src/allowlist.ts` and the L15 facts.

### 7.6 Security findings

Adopted: the public pointer, private draft advisories, a model with no advisory token, and opaque ledger IDs keyed with `PR_REVIEW_ID_KEY` (RP §7.8–7.9). Draft advisories work on public repos.

Adapted for a repo whose subject is security:

- **Security-relevant here** means C1–C5. It also means anything describing an input or sequence that gets past the safety hook, the delegation guard or read confinement; a secret-exposure path; or a fail-open.
- **Pointer granularity.** The module is public and nearly every PR touches it, so a pointer that only says "security-relevant issue (High)" tells Marcus nothing. The pointer may name the policy area from a fixed list (`shell rules`, `git rules`, `path confinement`, `secret families`, `delegation guard`, `allow rules`, `hook wiring`). It never names a file, a line, a mechanism or an input.
- **Loosenings that the PR text declares** (G3) are not security findings by default. Only an undeclared loosening of a deny rule is.
- **Volume check.** If most findings on a PR are security pointers, the summary is mostly pointers. The trial measures whether this is useful. If it isn't, Q1 below is the lever.

### 7.7 Output

Adopted from RP §7.7: one sticky summary with a hidden ledger, inline comments only for non-security Critical/High findings with fingerprints, publish-side guards, redaction, and "partial/incomplete" is never "No issues found". Local deltas:

- **Summary sections.** "Promises touched" replaces "Features touched", "Cross-artifact impact" replaces "Cross-package impact", and a "Loosenings" table (declared / undeclared / unclear) is added.
- **Inline cap: 5** rather than 10. These PRs arrive already reviewed several times, and noise is the main failure.
- **No PR-title convention check.** Merge commits mean commit subjects matter instead (§6).

### 7.8 Learning from Marcus's feedback

Adopted wholesale from the engine (rollout brief `<feedback_learning>`). Settings for this repo:

- **Trusted authors:** `marcusk639`. Everyone else's reactions and replies are ignored, including the bot's own.
- **Lesson destinations:** `false-positives.md`, `conventions.md`, `checklist.md` and `contract-map.md` first, then `learned.md`.
- **Protected classes:** C1–C5. A 👎 never suppresses them, and any lesson that narrows them is flagged in the learning PR for Marcus's decision. Feedback on security findings arrives through the advisory, and only a non-revealing pattern may become memory.
- **Merge policy:** every lesson goes through the learning PR. No automatic merge is proposed for this repo, because most of its classes are security classes (Q5).
- **Seed:** `learned.md` starts empty. Rulings already made go into `false-positives.md` (brief §9).

### 7.9 Delivery order

Adopted from RP §7.10. Skeleton PR, merge, secrets (`CLAUDE_CODE_OAUTH_TOKEN`, `PR_REVIEW_ID_KEY`, `SECURITY_ADVISORY_TOKEN`), then a test PR, replay PRs, a feedback round trip, and a trial. Replay candidates, built on throwaway branches with clearly labelled planted bugs, never real bypasses:

1. A role renamed in `src/team.ts`, with `src/orchestrator/prompt.md` unchanged (L1).
2. A section tag renamed in a specialist's `prompt.md` (L2, consumer-breaking).
3. A deny case moved to `allows(` with no mention in the PR body (L15, G3). This is the planted security replay, judged on the pointer revealing nothing beyond area and severity.
4. A new ledger outcome word, with the orchestrator prompt unchanged (L6).
5. An SDK version bump with no re-verification note (L12).
6. A PR body claiming "N tests pass" that doesn't match the diff, or "verified live" with no evidence (C11).

**Historical dry runs** before any GitHub step: facts plus publish `--dry-run` on `747b8a6...09f238e` (PR #1, L1/L14), on PR #5 (`9fe2d03...74ef64e`, the L15 loosenings it declares, which should come out "declared"), and on `a945089` alone (C2, the carve-out that later had to be withdrawn).

## 8. Acceptance criteria (applicable from RP §8)

1. The skeleton posts with zero permission denials (RP §8.1).
2. The replay set in §7.9 is flagged with the correct other side (RP §8.2, adapted).
3. A clean PR, such as a docs-only change to `docs/prompts/`, produces no Critical/High findings (RP §8.3).
4. Hooks and MCP servers don't run (RP §8.4). This is vacuous today, but stays a check.
5. Forks and drafts are skipped, and a PR with a non-`main` base follows Q2 (RP §8.5, adapted).
6. A run on a PR the size of #4 finishes within its caps, and turns and duration are reported (RP §8.6).
7. Incremental runs: two pushes (a fix and a docs change) pick the expected tiers with no re-posts. Base-drift is dropped (RP §8.7, adapted).
8. A planted security finding leaks nothing beyond severity and area anywhere public (RP §8.8).
9. The feedback round trip changes behaviour on the next PR (new).
10. Trial: Marcus reacts to every finding for two weeks or ten PRs, whichever comes first, given the low volume. The target is at least 70% 👍 and no wrong Critical/High (RP §8.9, adapted).

## 9. What this project needs from the shared engine

Configuration points:

- **`trustRef`**: load knowledge and project checks from the default branch head rather than the PR base. Alternatively, a `baseBranches` filter that skips PRs not targeting `main`.
- **Routing:** project-owned `routing.json` (paths → link types → classes → counterparts), plus a per-class `security: true` flag.
- **Security area vocabulary:** a fixed list of area names the pointer may use (§7.6).
- **Tiers:** enable or disable each tier, per-tier turn caps, `behaviouralDocs` globs that are never docs-only, and `sizeExclude` globs for the large-PR threshold.
- **Inline:** cap and minimum severity.
- **Secret scan:** extra patterns plus a fixture allow-list (path glob and value pattern). PII heuristics on or off.
- **Commit convention check:** commit subjects or PR title, with the regex as configuration.
- **Self-edit paths:** the workflow file and `.claude/pr-review/**`.
- **Skip rules:** drafts, forks, bots and branch prefixes.
- **Learning:** trusted authors, protected classes, lesson destination files, schedule, and auto-merge policy.
- **Visibility:** `public`, which drives redaction strictness and the private channel.
- **Model and limits:** model ID, job timeout, and a `--dry-run` publish mode.

Extension hooks:

- **Project fact modules:** `.claude/pr-review/checks/*.mjs`, loaded from the trusted ref, each exporting a function that takes the diff, the changed files and a read-only file accessor and returns fact lines. They are limited to Node built-ins, and a throw becomes "pre-check unavailable" (RP §7.4).
- **Procedure addendum:** the engine's `REVIEW.md` includes a project `REVIEW.addendum.md` and the project's knowledge file list. The addendum can rename summary sections (Promises touched, Cross-artifact impact) and add one (Loosenings).
- **Extra summary section** rendered from a project fact, the Loosenings table, if rendering is engine-owned.

## 10. Adopted, adapted, dropped

| recovery-platform element                                      | Here          | Why                                                                                                                                  |
| -------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Advisory only, never blocking                                  | Adopted       | Same reason. Marcus weighs findings.                                                                                                 |
| Base-branch knowledge and scripts                              | **Adapted**   | Default-branch head instead of PR base, because stacked PRs are normal here (#1→#2→#3).                                              |
| Sandboxed model, model-free publish                            | Adopted       | It reads untrusted PR text in a public repo.                                                                                         |
| `disableAllHooks`, `--strict-mcp-config`                       | Adopted       | Vacuous today. It keeps behaviour stable if the repo later adds `.claude/` settings.                                                 |
| Cross-package pass and contract maps                           | **Adapted**   | Becomes a cross-artifact pass over string links (L1–L15). Imports are typechecked, but prompts, tests, help text and the SDK aren't. |
| Feature-impact pass                                            | **Adapted**   | Operator promises (brief §1). The project has no end-user features.                                                                  |
| 14-class checklist                                             | **Replaced**  | With C1–C12 mined from this repo's fix commits.                                                                                      |
| Firestore, callable, region and index checks; `verify-diff.sh` | Dropped       | They don't exist here.                                                                                                               |
| 300-line rule                                                  | Dropped       | No such rule in this repo.                                                                                                           |
| PR-title conventional-commit check                             | **Adapted**   | Commit subjects, because PRs land as merge commits.                                                                                  |
| PII-in-log heuristics                                          | Dropped       | No PII domain.                                                                                                                       |
| Secret scan                                                    | **Adapted**   | With a fixture allow-list for test credentials.                                                                                      |
| Tiers: none/full/incremental                                   | Adopted       | Every push gets reviewed without duplicates.                                                                                         |
| Tiers: light, base-drift                                       | Dropped       | `light` would misclassify prompt edits. Base drift is rare with one author and short-lived PRs.                                      |
| Ledger, fingerprints, sticky summary                           | Adopted       | Engine-owned.                                                                                                                        |
| Inline cap 10                                                  | **Adapted**   | 5, because PRs arrive pre-reviewed.                                                                                                  |
| Public pointer and draft advisory                              | **Adapted**   | Kept, and the pointer may name a fixed policy area, because nearly every finding is in one public module.                            |
| Self-edit High finding                                         | Adopted       | Same gap: `pull_request` runs the PR's own workflow file.                                                                            |
| `e2e-fix/*` skip                                               | Dropped       | No such branches.                                                                                                                    |
| Replay set and two-week trial                                  | **Adapted**   | Repo-specific replays (§7.9). The trial is bounded by PR count as well as time, given the low volume.                                |
| Feedback learning                                              | Adopted (new) | Trusted is Marcus only. C1–C5 are protected. No auto-merge.                                                                          |

## 11. Open questions for Marcus

1. **Q1. Public detail for safety-hook findings.** PR bodies already list known-gap categories publicly (PR #5). Should the reviewer keep bypass findings private, as designed, or post them publicly like the PR bodies do? Recommendation: private, because a PR body describes gaps the author chose to accept, while a reviewer finding may be an unaccepted, working bypass.
2. **Q2. Stacked PRs.** Should knowledge load from `main`'s head for PRs with a non-`main` base, as designed, or should those PRs be skipped?
3. **Q3. CI.** Should a minimal `pnpm typecheck && pnpm test` workflow be added as separate work? Without it nothing on GitHub runs the tests, and the reviewer's "PR text claims N tests pass" check can only compare text.
4. **Q4. Merge style.** Do you intend merge commits, or squash as PR #5 asked? It decides whether the reviewer checks commit subjects or the PR title.
5. **Q5. Auto-merging lessons.** The proposal is none for this repo. Do you agree?
6. **Q6. Consumers.** Do other repos already use `.claude/dev-team/` customizations? If so, L1/L2 renames rate High (breaking); if not, Medium.
7. **Q7. Inline cap.** Is 5 right, or should it be 10 as in recovery-platform?

## 12. Follow-ups outside this project

- A CI workflow for typecheck and tests (Q3).
- A test that cross-checks role names in `src/orchestrator/prompt.md` against `ROLES` (L1). PR #1 flagged it, and it is still unchecked.
- Prettier protection for `plugin/**/SKILL.md` if its bytes matter for caching (L14).
