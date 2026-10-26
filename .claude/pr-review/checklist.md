# Bug-class checklist

These are the recurring classes, mined from this repo's fix commits and PR descriptions (`docs/reports/pr-reviewer-project-brief.md` §4). `routing.json` decides which classes a run applies. Class 11 always applies. The evidence entries are history to learn from, not open issues: each class names the pattern, never an input that works on `main`. Finding `class` numbers in `findings.json` use the numbers below. Classes 1 to 5 are security classes.

## 1. Alternate shell spelling slips past a deny rule

- **Look for:** a new or changed rule in `src/permissions/shell.ts` or `src/permissions/git.ts` that matches one spelling of a command while the shell accepts others. Check separators (newline as well as `;`, `&&` and `|`), quoting and backslashes, nested shells and their options, wrappers, variables and substitutions in words, and interpreter built-ins that do the same thing. Check that the rule runs on the text the shell will actually execute, after the same normalization the other rules get.
- **Trigger paths:** `src/permissions/**`, `src/permissions.ts`.
- **Evidence:** `1669bb5` (a newline split tool and subcommand), `993b29a` (a nested shell's option taken as the outer command's), `7d2aed0` (variables inside words), `157a6eb` (an interpreter built-in that dumps the environment), `37db442`. PRs #4 and #5.

## 2. A carve-out in a deny check opens a hole

- **Look for:** an exemption, a stripping step or an early allow added to a deny check ("allowed because it is a commit message", "a no-op editor", "a safe key"). Ask what else has the exempted shape, and whether stripping runs before the other checks and so hides text from them. Exemptions over free text are the riskiest.
- **Trigger paths:** `src/permissions/**`, `src/permissions.ts`, `src/allowlist.ts`.
- **Evidence:** the message-stripping exemption: `a945089` added it, `993b29a` and `1060fec` patched it, and `74ef64e` withdrew it after three rounds of bypasses (PR #5, finding I3).

## 3. Path confinement and resolution

- **Look for:** a path check on the literal path but not the normalized or symlink-resolved one; `~` read as a directory under `--cwd`; a glob whose static base is outside `--cwd`; `..` in Grep glob pieces; rule syntax that differs from Claude Code's (`//abs`, `~/`, `/` is project-relative); a root that opens `/`, home or a parent of `--cwd`.
- **Trigger paths:** `src/permissions/paths.ts`, `src/permissions/globs.ts`, `src/permissions.ts`, `src/allowlist.ts`.
- **Evidence:** `37db442` (reads through a symlink), `7d2aed0` (Glob pattern bases), `d4be76b` (allow-rule path syntax, whole-filesystem roots), `993b29a` (`~`).

## 4. Fail-open on unexpected input

- **Look for:** a tool input that is not an object, a command or path that is not a string, an `lstat` or `realpath` error, or an exception, that ends in "allow" or leaves the decision to the SDK. The repo's rule is that anything that can't be evaluated denies (`safeDenyReason`, the hook's outer `try`).
- **Trigger paths:** `src/permissions.ts`, `src/permissions/**`, `src/orchestrator/index.ts`.
- **Evidence:** `5a015ea` (malformed input and EACCES now deny), `6a07bd6` (any throw in the hook denies).

## 5. One rule family updated in one tool but not the others

- **Look for:** a secret file name, protected path or write tool added to one list (Read's secret paths, the shell's mention list, Grep glob families, `WRITE_TOOLS`) but not to its siblings, so another tool can still reach it. See the `protected-paths`, `secret-families` and `tool-names` sections of the contract map.
- **Trigger paths:** `src/permissions/paths.ts`, `src/permissions/shell.ts`, `src/permissions/globs.ts`, `src/tools.ts`, `src/allowlist.ts`.
- **Evidence:** `37db442` (secret files reachable by Bash and Glob but not Read), `2036d8a` (every write tool now needs a specifier).

## 6. Evidence or outcome reported as better than it was

- **Look for:** a ledger outcome of `ok` for a call that ran in the background, was interrupted or never settled; supersession ("later passed") matched too broadly; a stream with no result exiting 0; faults that are logged but not counted; `--strict` missing a case it should count.
- **Trigger paths:** `src/ledger.ts`, `src/outcome.ts`, `src/orchestrator/summary.ts`, `src/orchestrator/index.ts`.
- **Evidence:** `5347d54` (background calls recorded as started), `1e92a4d` (supersession and interrupts), `94c9cd6` (no result is a failure), `6f8ecdc`.

## 7. A prompt, help text or comment claims something the harness doesn't enforce

- **Look for:** a prompt that promises or forbids something the code doesn't do; a role prompt that offers a tool the role doesn't have; usage text that misstates a default, a flag or what `--yes` approves; a comment that states an SDK behaviour as verified when it isn't.
- **Trigger paths:** `src/**/prompt.md`, `plugin/**`, `src/cli.ts`, any `src/**/*.ts` comment.
- **Evidence:** `432a8bb` (ux-designer offered to write files), `2a753a6` and `1561cd1` (prompts brought in line with enforcement), `9344df1` (drifted comments).

## 8. Silent misconfiguration accepted

- **Look for:** an input that should fail fast but is ignored, misread or turned into a default, such as an empty file, a symlinked customization, an unknown name, a rule that can never take effect, or an error message that hides the cause.
- **Trigger paths:** `src/cli.ts`, `src/prompts.ts`, `src/project-agents.ts`, `src/allowlist.ts`, `src/team.ts`.
- **Evidence:** `9344df1` (an empty `--file` printed help and exited 0), `ae01bc2` (project agents shadowing built-ins), `2036d8a`, `6907fa3`.

## 9. SDK behaviour assumed, not verified

- **Look for:** new code that depends on how SDK 0.3.283 behaves (hook fields, where it creates files, which tools a mode approves, undocumented env vars) without a comment saying it was verified live or is unverified; or an SDK version change that leaves those assumptions unchecked. When a safety rule depends on the assumption, treat the finding as security-relevant.
- **Trigger paths:** `package.json`, `src/orchestrator/index.ts`, `src/project-agents.ts`, `src/permissions.ts`, `src/ledger.ts`.
- **Evidence:** `2475ea5` (worktree isolation lands under `.claude/`), `eb1cd94` (`agent_type` is set on the main thread too), `8746b35` (background subagents bypassed the hook).

## 10. Over-blocking, or a loosening nobody called out

- **Look for:** a rule that now denies a legitimate, common workflow without saying so; and the reverse, a rule or test changed so that something denied before is now allowed, with no mention in the PR text. The second one is security-relevant: report it as class 2 or 12 with `"security": true`.
- **Trigger paths:** `src/permissions/**`, `src/permissions*.test.ts`, `src/allowlist.ts`, `src/allowlist.test.ts`.
- **Evidence:** `36ed855` (no-op git editors and `.env.ts` modules allowed again), `37db442` (`git rm -r --cached` allowed again). PR #5's "Intentional loosenings" section is the expected way to declare one.

## 11. PR text claims things the code or the merge doesn't do

- **Look for:** test counts, "verified live" and "pinned by a test" claims the diff doesn't support; a known-gaps or loosenings list that leaves out what the diff does; merge instructions; a stacked PR's base. Check commit subjects in `<OUT>/commits.txt` too, since PRs land as merge commits.
- **Trigger paths:** any.
- **Evidence:** PR #3 exists because PR #2 merged into a non-default base. PR #5 asked for a squash merge, and `9fdc3fb` is a merge commit.

## 12. A test that can't catch the regression

- **Look for:** a policy test that asserts only "denied" where the suite's convention pins the exact reason; a deny case deleted or moved to the allow side; a test whose input never reaches the rule it names. The `policy-loosening` fact lists moved and removed deny cases.
- **Trigger paths:** `src/**/*.test.ts`.
- **Evidence:** no history yet. Derived from the repo's convention that every reviewed bypass is pinned with its exact input and reason (PR #5), and from the `policy-tests` link.

<!-- pr-review:learned:begin -->
<!-- pr-review:learned:end -->
