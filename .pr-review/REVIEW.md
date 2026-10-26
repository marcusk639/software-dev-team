# Project addendum to the review procedure

Read this after the kit's procedure (`<OUT>/REVIEW.md`). It covers what is specific to `software-dev-team`, and where it is more specific than the kit, follow it. The reasoning behind it is in `docs/specs/pr-reviewer-design.md` and `docs/reports/pr-reviewer-project-brief.md`. The brief is a snapshot of `9fdc3fb`, so confirm anything it says against the code.

## What this project is

A CLI that runs an Engineering Manager agent on the Claude Agent SDK. The manager delegates to eleven specialist subagents (`src/team.ts`). Every tool call first passes a PreToolUse safety hook (`src/permissions.ts`, `src/permissions/`). The team works on real files in a target checkout, often unattended (`--yes`), and what it reads there (repo files, web pages, specialists' reports) is untrusted.

It has no end users and no product features. Instead of "features touched", report the **operator promises** a change puts at risk, by name:

- **safety:** destructive commands, secret reads, writes outside `--cwd` or to protected paths
- **role boundaries:** the manager only reads, plans and delegates; delegation goes only to known agents, with no model override and no isolation
- **honest evidence:** the ledger and the run outcome never report a run as better than it was
- **prompt customization:** consumers' `.claude/dev-team/` files keep working, and typos fail fast
- **CLI contract:** flags, help text, `--allow` syntax and exit codes 0, 1, 2 and 3

Use these names in `summary.md` under the heading `## Promises touched`, in place of `## Features touched`. Use `## Cross-artifact impact` in place of the cross-package heading.

## How review fits this project

- **Local reviews already happened.** Marcus runs several local reviewer agents on every PR before he opens it. Generic review findings ("add a test", style, naming) are noise here. Your value is in the passes below.
- **Cross-artifact pass.** Modules import each other and are typechecked, so code-to-code breaks are rare. The links that break are carried by strings: role names in prompt prose, prompt section tags, ledger wording the manager's prompt describes, tool-name lists, protected-path and secret-name families kept separately for each tool, help text, `--allow` syntax, and assumptions about SDK 0.3.283. `contract-map.md` lists them. Open both sides before you report one.
- **Behavioural markdown is code.** `src/**/prompt.md` and `plugin/**/SKILL.md` are what the agents run on. Review a change to them as you would code: does the prompt still describe what the harness enforces (class 7), and does it still use the names and sections the code and consumers rely on?
- **Loosening audit.** The `policy-loosening` fact gives the count and the `file:line` of each case that left a deny table of a policy test suite, and of each new allow case. It never quotes the case: read it from `<OUT>/pr.diff`. It reads only the `denies`, `allows` and `check` tables and the accepted-false-positive list, so a suite written as loops or plain `it()` calls (such as `src/allowlist.test.ts` and `src/permissions-hook.test.ts`) produces no fact, and that silence is not coverage. Review those diffs yourself. Also, `carve-outs` lists added lines that look like exemptions. For each one, check whether the PR description names it as an intentional loosening, with a reason. PR #5 is the model: it lists "7 of 528" intentional loosenings. Add a `## Loosenings` section to `summary.md` with a table of change, declared (yes or no) and where. Never put an input that now gets past the hook in that table: name the rule family only (see "Security boundary"). An undeclared loosening of a deny rule is a security-relevant finding, class 2 or 12.
- **Carve-outs first.** When the diff adds an exemption, stripping or early `return null` to a deny check, read it before anything else. Class 2 cost four review rounds and was withdrawn (`74ef64e`).
- **PR-text accuracy (class 11, always).** PR descriptions here are long and specific: test counts, "verified live", lists of known gaps and loosenings, merge instructions. Check each concrete claim the diff can settle, and say which claims it can't (for example "N tests pass": there is no CI, so nothing on GitHub ran them).
- **Commit subjects, not the PR title.** PRs land as merge commits, so every commit subject in `<OUT>/commits.txt` reaches `main`. Subjects are conventional: `feat|fix|refactor|docs|chore|test|perf|ci`, an optional scope such as `(cli)` or `(prompts)`, and a body that says why. A bare or misleading subject is at most Low.
- **No CI.** Neither you nor anything on GitHub runs `pnpm typecheck` or `pnpm test` for this repo. Never write that tests pass. If the PR's own claim depends on them, say it is unverified.

## Security boundary

The repo is public, and its subject is a safety policy. A concrete input that gets past the hook, the delegation guard or read confinement, posted anywhere public, is an exploit against anyone who runs the team on content they don't control.

- Security-relevant here means classes 1 to 5. It also means any finding that describes an input or sequence the safety hook, the delegation guard or read confinement would let through; a path that exposes a secret value; or a fail-open. Set `"security": true`. Publish then posts only a pointer and sends the details to a private draft advisory.
- `package` is the kit's package (`src`, `plugin` or `repo`). `area` must be one of these, exactly: `shell rules`, `git rules`, `path confinement`, `secret families`, `delegation guard`, `allow rules`, `hook wiring`, `ledger`. Use no other words.
- A loosening the PR text declares, with a reason, is not a security finding by itself. Say in `## Loosenings` that it is declared, without the input.
- Known-gap categories the repo already documents (`false-positives.md`) are not new findings unless the PR claims to close one, or widens one.

## Large PRs

Policy PRs often add hundreds of test cases, and about half of each large PR is tests. Past the "Large PR" limits, read these first:

1. the `policy-loosening` and `carve-outs` facts and the lines they point at
2. `src/permissions/**`, `src/permissions.ts` and `src/allowlist.ts`
3. `src/orchestrator/index.ts` (`prepareRun` wiring) and `src/ledger.ts`
4. changed `prompt.md` files

Test files come last. Read them only where a fact points.

## Severity calibration

- **Critical:** a change that lets a destructive command, a secret read or a write to a protected path through in `--yes` mode, or that turns a fail-closed path fail-open. Always security-relevant.
- **High:**
  - an undeclared loosening
  - the manager able to run tools outside `MANAGER_ALLOWED`
  - a ledger or outcome change that reports a failed, blocked or unfinished call as ok
  - an SDK bump that drops a behaviour a safety rule depends on
  - a self-edit of the reviewer
- **Medium:**
  - a role or prompt-section rename that breaks the prompts or tests that name it (Marcus's call: consumers are not known to exist yet)
  - help text or prompts that misstate what is enforced
  - silent misconfiguration
- **Low:**
  - commit-subject format
  - comments that drift
  - missing "unverified against 0.3.283" markers on new SDK assumptions
