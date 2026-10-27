# PR reviewer: GitHub runbook for software-dev-team

These are the steps that need GitHub, in order. Each step that is visible outside this machine waits for Marcus's explicit approval. The design is `docs/specs/pr-reviewer-design.md`, and the order follows recovery-platform's spec §7.10 and §10: the engine and the knowledge must be on `main` before they review anything, because rules and checks are read from the base commit.

Repo: `marcusk639/software-dev-team` (public, default branch `main`). Local branch: `chore/pr-review` in `~/dev/.worktrees/software-dev-team-pr-review`.

## 0. Before anything is pushed

- [ ] The kit carries the mandatory security properties (spec §9). Re-pin both workflows to that kit SHA: every `pr-review-kit/actions/*@` line in `.github/workflows/pr-review.yml` and `.github/workflows/pr-review-learn.yml`.
- [ ] Run `node <kit>/bin/pr-review.mjs validate` from the worktree, using that kit SHA. Expect `validate: ok`.
- [ ] Run `node --test '.pr-review/checks/test/*.test.mjs'`. Expect every test to pass.
- [ ] Run `actionlint .github/workflows/pr-review*.yml`. Expect no output.
- [ ] `marcusk639/pr-review-kit` is pushed and public, and the pinned SHA exists on GitHub.

- [x] Both workflows are pinned to kit `098dcc7ea8d0a69cfb3eac0c076595808fe53502` (the final kit release, after P0.2 `7cc0b4a`; it includes P0, P0.1, P0.2, P1 and P2). Don't merge a different pin.
- [x] **The kit's P0.1 release is pinned. This is not the final precondition: see P0.2 below.** Project checks run isolated (no `GH_TOKEN`, empty cwd, kill timeout), with `ctx.git` and `ctx.mergeBase`. Re-verified at `fb07975`: `validate`, `actionlint`, the check tests and the five historical dry runs all pass, and the learning workflow checks out the default branch.
- [x] **Re-pinned to the kit's P0.2 release (`7cc0b4a`), the final engine precondition.** Re-verified at the final pin `0d2693d`: `validate` ok, `actionlint` clean, 40/40 check tests, the five historical dry runs unchanged, and the planted-security render leaks nothing. P0.2 fixes two High issues from the engine's re-review: the learning-PR bot identity could be spoofed through the git author name, and withheld globs were silently dropped. It also fixes four Medium issues. After re-pinning, re-run `validate`, `actionlint`, the check tests and the five historical dry runs. Don't merge a pin older than P0.2.

## Standing rule: the workflow is editable by any PR

`pull_request` runs the workflow from the PR head, so any branch pushed here, including one pushed by an agent running with Marcus's credentials, can rewrite `pr-review.yml` and read the review job's secrets. Every such PR gets the self-edit High finding. **Rotate `CLAUDE_CODE_OAUTH_TOKEN`, `PR_REVIEW_ID_KEY` and `SECURITY_ADVISORY_TOKEN` after any suspicious PR, and after any unintended edit to `.github/workflows/pr-review*.yml`.**

## 1. Skeleton PR (approval: push and open a PR)

- [ ] Push `chore/pr-review` and open a PR into `main`. This PR adds the reviewer, so it is reviewed without its own knowledge: `main` has no `.pr-review/` yet, so facts finds no project and the model doesn't run. Expect the job to log "no .pr-review/config.json on the base branch yet; review skipped" and publish to post nothing ("skipped: project config"). This run needs no secrets, and it proves the trigger and guards work.
- [ ] Merge it with a merge commit (Q4).

## 2. Secrets and settings (approval for each)

- [ ] `CLAUDE_CODE_OAUTH_TOKEN`: `gh secret set CLAUDE_CODE_OAUTH_TOKEN -R marcusk639/software-dev-team`. Marcus pastes the value.
- [ ] `PR_REVIEW_ID_KEY`: a random 32-byte hex key, for example `openssl rand -hex 32 | gh secret set PR_REVIEW_ID_KEY -R marcusk639/software-dev-team`.
- [ ] `SECURITY_ADVISORY_TOKEN`: a fine-grained PAT that only Marcus can create. Scope it to this repo only, with "Repository security advisories: Read and write" and nothing else. Then run `gh secret set SECURITY_ADVISORY_TOKEN -R marcusk639/software-dev-team`.
- [ ] Settings → Actions → General: turn on "Allow GitHub Actions to create and approve pull requests". The learning workflow's `propose` job needs it.
- [ ] Settings → Code security: check that private vulnerability reporting and advisories are available. They are on public repos.

## 3. Test PR

- [ ] Open a small real PR into `main`, for example a comment fix in `src/cli.ts`. Expect:
  - [ ] a summary comment from `github-actions[bot]` with tier `full`, and zero `permission_denied` in the run (acceptance 1)
  - [ ] the job log shows hooks disabled, no MCP servers, no project settings loaded, and the PR-head agent config neutralized (acceptance 4)
  - [ ] the observed turns and duration recorded here, for tuning the caps
- [ ] Push a second commit that only changes `docs/`. Expect tier `light` or `none`, and no re-posted comments (acceptance 7).
- [ ] Open a PR whose base is another branch. Expect the review job not to run (acceptance 5).

## 4. Replay PRs (throwaway branches, clearly labelled, closed afterwards)

Every planted bug is fake and labelled `PLANTED` in its commit message and PR title. None is a real bypass.

| #   | Branch                        | Plant                                                                                                                                     | Expect                                                                                                                                                                                                          |
| --- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | `replay/role-rename`          | Rename `qa-tester` to `quality-tester` in `src/team.ts` and its directory only                                                            | A `role-names` fact. A Medium finding citing `src/orchestrator/prompt.md`. Promises: role boundaries, prompt customization.                                                                                     |
| R2  | `replay/section-rename`       | Rename `<safety>` to `<guardrails>` in `src/agents/team/prompt.md`                                                                        | A `prompt-sections` fact (consumer-breaking). A Medium finding citing the required-sections test in `src/team.test.ts`.                                                                                         |
| R3  | `replay/undeclared-loosening` | Move one harmless, clearly fake deny case to an `allows` block, with a matching fake rule change, and say nothing about it in the PR body | A `policy-loosening` fact with the location only. In the summary, the `## Loosenings` section shows "Undeclared: 1" and no row, location or detail for it. A security pointer naming only severity, package and area, with the details in a draft advisory (acceptance 8). Then grep every public output for the planted case literal: the summary and inline comments (`gh api`), the hidden ledger (decode it), and the job log and any artifacts (`gh run view --log`). Expect zero hits. Run R3 only after one harmless finding has proved the advisory path. |
| R4  | `replay/ledger-word`          | Add a new outcome word in `src/ledger.ts`, with the orchestrator prompt unchanged                                                         | A finding on the `ledger-text` link citing `src/orchestrator/prompt.md`.                                                                                                                                        |
| R5  | `replay/sdk-bump`             | Bump the SDK version in `package.json` only                                                                                               | An `sdk-pin` fact listing the files that still name `0.3.283`, and a class 9 finding.                                                                                                                           |
| R6  | `replay/pr-text`              | A PR body claiming "1300 tests pass, verified live" for a one-line change                                                                 | A class 11 finding that says the claim is unverified (no CI).                                                                                                                                                   |

Close each PR and delete its branch afterwards. Delete the draft advisory R3 created, with Marcus's approval.

## 5. Feedback round trip

- [ ] On R1 or R4, 👎 a finding as `marcusk639` and reply to it with `review: <correction>`, for example `review: the counterpart for ledger wording is X, not Y`.
- [ ] Push to that PR again. Expect the 👎'd finding to not be re-raised, and the correction to appear in `facts.md` as quoted data.
- [ ] Run the learning workflow by manual dispatch (approval). Expect one learning PR from `pr-review/learning` with the lesson scoped to that path and class, its source link and the precision table. The learning PR is itself reviewed, and the self-edit High finding is expected on it.
- [ ] Merge the learning PR (Marcus).
- [ ] Open a new PR that triggers the same situation. Expect the reviewer's behaviour to follow the lesson (acceptance 9).
- [ ] Negative checks:
  - A reply from any other account produces nothing.
  - A 👎 on R3's security finding doesn't demote class 2.

## 6. Trial

- [ ] Two weeks or ten PRs, whichever comes first. Marcus reacts 👍/👎 to every finding. The target is at least 70% 👍 and no wrong Critical or High finding (acceptance 10). Below target, tune the knowledge files and caps before calling it done.

## Rollback

Disable the workflow in the Actions tab, or revert the commit that adds it. Posted comments and draft advisories can be deleted. Nothing else changes.

## Acceptance checks that apply (recovery-platform spec §8)

| RP §8 | Applies                  | Where                                          |
| ----- | ------------------------ | ---------------------------------------------- |
| 1     | yes                      | step 3                                         |
| 2     | yes, replay set R1–R6    | step 4                                         |
| 3     | yes                      | step 3, docs push                              |
| 4     | yes, strengthened        | step 3                                         |
| 5     | yes, plus non-main bases | step 3                                         |
| 6     | yes                      | step 3, and a PR the size of #4 when one comes |
| 7     | yes, no base-drift test  | step 3                                         |
| 8     | yes                      | R3                                             |
| 9     | yes, adapted             | step 6                                         |
