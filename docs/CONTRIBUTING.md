# Contributing

How to set up the repository, the conventions it follows, and what a pull request needs. For the code itself, see [architecture.md](architecture.md) and [extending.md](extending.md). For tests, see [testing.md](testing.md).

## Setup

You need Node 22, pnpm and git.

```bash
git clone https://github.com/marcusk639/software-dev-team.git
cd software-dev-team
pnpm install
pnpm typecheck && pnpm test     # about 1,600 tests, a few seconds, no credentials needed
```

To try a change against a real project, run it from source (`pnpm start …`, [usage.md](usage.md)). `pnpm dev` restarts on source and `prompt.md` changes. Point `--cwd` at a scratch checkout, not at this repository, unless you mean for the team to edit itself.

## Scripts

<!-- AUTO-GENERATED from package.json "scripts"; regenerate when they change -->

| Command                      | Runs                                                  | Purpose                                                                                                                                               |
| ---------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm start`                 | `tsx src/index.ts`                                    | The CLI. `pnpm start --help` lists its options.                                                                                                       |
| `pnpm dev`                   | `tsx watch --include "src/**/prompt.md" src/index.ts` | The CLI, restarted when a source file or a prompt changes.                                                                                            |
| `pnpm typecheck`             | `tsc --noEmit`                                        | Type-check `src/` (tests included) and `scripts/`.                                                                                                    |
| `pnpm test`                  | `node --import tsx --test "src/**/*.test.ts"`         | The unit suite.                                                                                                                                       |
| `pnpm check:sdk-permissions` | `node --import tsx scripts/check-sdk-permissions.ts`  | Live check of the SDK's own permission matching. Costs a few cents; needs a Claude credential ([testing.md §7](testing.md#7-live-and-manual-checks)). |

<!-- END AUTO-GENERATED -->

## Repository layout

```text
src/
  index.ts, cli.ts          entry point and argument parsing
  orchestrator/             run preparation, the manager's prompt, the run summary
  agents/<role>/            each specialist: index.ts + prompt.md
  agents/team/prompt.md     conventions every specialist shares
  profiles/                 profile types, composition, registry, built-in profiles
  permissions.ts, permissions/   the safety policy and hook
  ledger.ts, test-authorship.ts, outcome.ts, report.ts   evidence and results
  publish.ts                the commit-and-push step
plugin/                     the team's Claude Code plugin (skills)
scripts/                    live checks that need a model
docs/                       documentation (start at docs/README.md)
.pr-review/                 the PR reviewer's project knowledge and checks
.github/workflows/          Claude and PR-review automation
Dockerfile                  the image for unattended runs
```

## Conventions

**TypeScript.**

- The project is ESM (`"type": "module"`) with `nodenext` resolution, so relative imports end in `.js` and type-only imports use `import type`.
- `tsconfig.json` turns on `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax`. Write code that passes them, rather than casting around them.
- The SDK is pinned to an exact version (`@anthropic-ai/claude-agent-sdk` 0.3.283). Some behavior is verified against that version only, so upgrade deliberately ([security.md S11](security.md)).

**Prompts.**

- `src/**/prompt.md` files are made of `<section>` blocks ([architecture.md §5](architecture.md#5-prompts)).
- Their bytes are kept stable for prompt caching, so Prettier never formats them (`.prettierrc`, `.prettierignore`), and `.gitattributes` keeps Markdown at LF.
- Edit them by hand, and keep section tags on their own lines.

**Formatting and linting.** There is no lint script, and Prettier isn't a dependency. Match the surrounding style; if your editor runs Prettier, it respects the prompt exclusions.

**Comments.** Explain why: a hidden constraint, an invariant, a workaround. Don't explain what the code plainly does. The safety code relies heavily on these comments, so keep them accurate when you change a rule.

**Tests first.** Write the failing test, watch it fail for the right reason, then make it pass ([testing.md §5](testing.md#5-test-driven-changes-and-review-rounds)). Pin the reason a safety rule denies, not just that it denies.

**Commits.** Use conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `ci:`, `perf:`. Keep the subject one line, and say why in the body.

**Docs.** A change to behavior a doc describes changes the doc in the same PR. A change to a cross-file contract (a role name, a section tag, a tool list, a protected path) updates every side listed in `.pr-review/contract-map.md` ([extending.md §10](extending.md#10-contracts-to-keep-in-sync)).

## Pull request checklist

- [ ] `pnpm typecheck` and `pnpm test` pass locally. Nothing on GitHub runs them.
- [ ] New behavior has tests that failed before the change. Safety rules have deny cases for abbreviations, wrappers and compound commands, and allow cases for near misses.
- [ ] Every side of a cross-file contract you touched is updated ([extending.md §10](extending.md#10-contracts-to-keep-in-sync)).
- [ ] Docs that describe the changed behavior are updated: [usage.md](usage.md), [deployment.md](deployment.md), `--help` text, and so on.
- [ ] A safety-layer change is recorded in the [security.md](security.md) register, and you have worked through its checklist (§3).
- [ ] The description says what changed and why, lists any loosening of a rule explicitly, and has a test plan.

## Automation on pull requests

| Workflow                                | Trigger                                                                                               | What it does                                                                                                                                                                                                                                                         |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/pr-review.yml`       | Non-draft PRs into `main` from this repository (forks and Dependabot skipped), and once more on merge | An advisory, repo-aware reviewer ([pr-review-kit](https://github.com/marcusk639/pr-review-kit)). It comments only and is never a required check.                                                                                                                     |
| `.github/workflows/claude.yml`          | `@claude` in an issue, PR comment, review or review comment, by the owner, a member or a collaborator | Claude answers, or makes the change on a branch. It may run `pnpm test`, `pnpm typecheck` and `node --import tsx --test …`. PRs from forks and agent-authored branches (`hco/*`, `e2e-fix/*`) are skipped, because their author controls the tests Claude would run. |
| `.github/workflows/pr-review-learn.yml` | Weekly, and on demand                                                                                 | Proposes changes to the reviewer's memory from feedback on its comments, as one PR.                                                                                                                                                                                  |

### Working with the PR reviewer

- **Where findings go.** It posts one summary comment, updated in place, plus inline comments. Each finding has an id such as `F-a92957`.
- **Feedback.** Give it with 👍/👎 on an inline comment, or a comment like `review: F-a92957 👎 <reason>`. Only the repository owner's unedited feedback counts.
- **Security-relevant findings** never appear in public comments; the summary shows only a pointer. The details go to a **private draft security advisory** under the repository's Security tab. A security finding stays "open" in the reviewer's ledger until a maintainer closes, withdraws or publishes its advisory, even after the code is fixed.
- **Withheld findings.** A non-security finding that touches a security-relevant file is listed as "(withheld: touches a security-relevant file)", without details.
- **Self-edits.** The reviewer's own configuration lives in `.pr-review/` and comes from the PR's base commit, never its head. Changing it is a "self-edit" the reviewer flags for a maintainer to accept knowingly.

The reviewer's design is in [docs/specs/pr-reviewer-design.md](specs/pr-reviewer-design.md).

### Secrets

| Secret                    | Used by             | Notes                                                                                                                                                                                                                                                |
| ------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`       | all three workflows | Holds a Claude **subscription token** from `claude setup-token`, despite its name; it is passed as `claude_code_oauth_token`. A real API key here wouldn't work. Replace it with `gh secret set ANTHROPIC_API_KEY -R marcusk639/software-dev-team`.  |
| `PR_REVIEW_ID_KEY`        | `pr-review.yml`     | 32+ random bytes, the HMAC key for the reviewer's private finding ids. Without it the reviewer drops security findings instead of filing them. Set it with `openssl rand -hex 32 \| gh secret set PR_REVIEW_ID_KEY -R marcusk639/software-dev-team`. |
| `SECURITY_ADVISORY_TOKEN` | `pr-review.yml`     | A fine-grained PAT for this repository only, with "Repository security advisories: Read and write". It files the draft advisories.                                                                                                                   |

GitHub access comes from the Claude GitHub App, which must stay installed on the repository. No workflow uses a personal access token for that.

**When workflow changes take effect.**

- An `@claude` on an issue or PR comment runs the default branch's copy of `claude.yml`.
- On a review it runs the PR's copy, but the action's token exchange only accepts workflows already on the default branch.

Either way, a change to `claude.yml` takes effect once it is merged.
