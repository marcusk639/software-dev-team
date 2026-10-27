# PR reviewer for software-dev-team: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:executing-plans. The phase 4 brief set the execution method (native: the project agent implements, then `code-reviewer` and `security-reviewer` review the branch). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give this repo a consumer of the shared reviewer `marcusk639/pr-review-kit`: workflows, project knowledge, project checks with tests, and seeded learned memory, all verified locally. Nothing is pushed.

**Architecture:** The engine runs from composite actions pinned by full SHA. Everything project-specific lives under `.pr-review/` and is read from the base branch: `config.json`, the `REVIEW.md` addendum, knowledge files, `routing.json`, `checks/*.mjs` and `learned/`. The project checks are pure functions over the parsed diff, plus `git show` of the base and head SHAs.

**Tech stack:** Node 22 built-ins only (`node:test`, `node:child_process`), GitHub Actions YAML, Markdown.

**Spec:** `docs/specs/pr-reviewer-design.md`. Background: `docs/reports/pr-reviewer-project-brief.md`.

## Global constraints

- Engine for dry runs: local `~/dev/pr-review-kit` at its HEAD. Workflows pin one full 40-hex kit SHA in every `uses:` line.
- `actions/checkout` is pinned by SHA in this repo's workflows: `actions/checkout@11d5960a326750d5838078e36cf38b85af677262` (v4.4.0, the v4 line the kit uses).
- Review only PRs whose base is `main` (`on.pull_request.branches: [main]`, plus a `base.ref == 'main'` job guard).
- Classes are 1–12 (brief C1–C12). Classes 1–5 are `security: true`. Class 11 is `always` and `light`.
- Inline: `max: 5`, severities Critical and High.
- Trusted feedback author: `marcusk639` only. Learning: `distill: "model"`, every lesson through the weekly learning PR, no auto-merge.
- Knowledge files hold patterns and counterpart paths only, never inputs that get past the safety hook on `main`.
- Project checks never throw on bad input. They return `[]` or facts of the form `{file, line?, note}`.

## Review focus

1. **A test file that isn't valid TypeScript, or has unbalanced brackets.** The block parser must return what it can, never throw (Task 1 test `unbalanced input`).
2. **A file added or deleted in the PR.** `git show` of the missing side fails. Treat it as empty (Task 2 test `new test file`).
3. **Regex literals that contain parentheses or quotes** (`/\(x\)/`, `/it's/`), which are common in these tests. They must not break the parenthesis matching (Task 1 test `regex literal`).
4. **A literal that appears in both a deny and an allow block of the same file.** Report it only when it moved from deny at base to allow at head (Task 2 test `moved`).
5. **An SDK version range written with `^` or `~`.** Compare the specifier strings exactly, and report any change (Task 3 test `sdk-pin`).

---

### Task 1: Block parser for policy test files

**Files:**

- Create: `.pr-review/checks/lib/case-blocks.mjs`
- Test: `.pr-review/checks/test/case-blocks.test.mjs`

**Interfaces:**

- Produces: `caseBlocks(source: string) => { verdict: 'deny' | 'allow', literals: string[] }[]`. It covers `denies(…)`, `allows(…)`, `check([…], "deny" | "allow")` and the array `ACCEPTED_FALSE_POSITIVES = […]` (verdict `deny`). Function declarations (`function denies(`) are skipped.

- [ ] **Step 1: Write the failing tests.**
  - `denies(R, [bash("rm -rf x")])` gives `[{verdict:'deny', literals:['rm -rf x']}]`.
  - `check([bash('a'), ["Read", {file_path: "b"}]], "allow")` gives one allow block whose literals contain `a` and `b`, but not `Read` and not `allow`.
  - Regex literal: `denies(/\(x\) it's/, [bash("y")])` gives the literals `['y']`.
  - Unbalanced input: `denies([bash("z")` does not throw.
- [ ] **Step 2:** Run `node --test .pr-review/checks/test/` and expect it to fail with a missing module error.
- [ ] **Step 3: Implement.** A single forward scanner with string, template, regex and comment states and a parenthesis or bracket depth counter. Tool names (`Bash`, `Read`, `Grep`, `Glob`, `Write`, `Edit`, `Agent`, `Task`) and the verdict words are not case literals.
- [ ] **Step 4:** Run the tests and expect them to pass.

### Task 2: `policy-loosening` and `carve-outs` checks

**Files:**

- Create: `.pr-review/checks/policy.mjs`
- Test: `.pr-review/checks/test/policy.test.mjs`

**Interfaces:**

- Consumes: `caseBlocks` from Task 1, and the engine context `{ files, baseSha, headSha, git }`.
- Produces: a default export of `[{name:'policy-loosening', run}, {name:'carve-outs', run}]`.

- [ ] **Step 1: Write the failing tests.** Use a temp git repo with base and head commits, and `files` built in the engine's shape.
  - Moved: `rm -rf x` is in a deny block at base and an allow block at head. Expect one fact whose note contains `deny→allow` and `rm -rf x`.
  - Removed: a deny literal is absent from head. Expect a note containing `deny case removed`.
  - Unchanged blocks give `[]`.
  - New test file: base has no such file. Expect `[]`, and no throw.
  - carve-outs: an added `return null;` line in `src/permissions/shell.ts` gives a fact on that line. The same line in `src/cli.ts` gives nothing.
- [ ] **Step 2:** Run the tests and expect them to fail.
- [ ] **Step 3: Implement.**
  - The test files in scope are `src/**/*.test.ts` whose name starts with `permissions` or `allowlist`.
  - Carve-out paths are `src/permissions.ts`, `src/permissions/**` and `src/allowlist.ts`.
  - The carve-out pattern is `/\breturn null\b|\b(?:allow|exempt|skip|strip|safe|ignore|except)\w*/i` on added lines, at most 10 facts per file.
  - Literals in notes are capped at 120 characters, and at most 10 per fact.
- [ ] **Step 4:** Run the tests and expect them to pass.

### Task 3: `role-names`, `prompt-sections`, `sdk-pin` and `tool-lists` checks

**Files:**

- Create: `.pr-review/checks/contracts.mjs`
- Test: `.pr-review/checks/test/contracts.test.mjs`

**Interfaces:**

- Produces: a default export of four checks with exactly those names.

- [ ] **Step 1: Write the failing tests.** Use a temp git repo.
  - role-names: `AGENTS` loses `"qa-tester"` and the head `src/orchestrator/prompt.md` still says `qa-tester`. Expect a note containing `removed role qa-tester` and the prompt path. An added role that no `prompt.md` mentions gets a note containing `not named in`.
  - prompt-sections: `<safety>` is renamed to `<rules>` in a `prompt.md`. Expect a note containing `removed section <safety>` and `consumer-breaking`.
  - sdk-pin: `"@anthropic-ai/claude-agent-sdk": "0.3.283"` changes to `"^0.4.0"`. Expect a note naming both versions and listing the head files that still contain `0.3.283`.
  - tool-lists: `"WebFetch"` is added to `MANAGER_ALLOWED`. Expect a note containing `MANAGER_ALLOWED +WebFetch`.
- [ ] **Step 2:** Run the tests and expect them to fail.
- [ ] **Step 3: Implement.**
  - Read both sides with `git show <sha>:<path>`, treating a failure as empty.
  - Find files containing a name with `git grep -l -F -e <name> <headSha> -- src plugin`.
  - Tool lists are the `export const X = [ … ]` blocks in `src/tools.ts` and `src/agents/shared.ts`, plus the `ToolName` union members.
- [ ] **Step 4:** Run the tests and expect them to pass.

### Task 4: Config, routing and knowledge

**Files (all under `.pr-review/`):** `config.json`, `routing.json`, `REVIEW.md`, `checklist.md`, `contract-map.md`, `conventions.md`, `false-positives.md`, `learned-lessons.md`, `learned/lessons.json`, `learned/precision.json`.

- [ ] **Step 1: Write the files from the spec.**
  - `config.json`: §7.2.
  - `routing.json`: §7.3, one entry per link type L1–L15 plus `review-config`.
  - `checklist.md`: a `## <n>. ` heading for each class 1–12.
  - `contract-map.md`: one `## <linkType>` section per routing entry.
  - `conventions.md` and `false-positives.md`: brief §5, §6 and §9 with sources.
  - Learned files seeded empty, in the engine example's format.
- [ ] **Step 2: Re-verify every path and claim against `main`.** Run `git show origin/main:<path>` for each cited file. Any backticked path must exist, because `validate` checks it.

### Task 5: Workflows

**Files:** `.github/workflows/pr-review.yml`, `.github/workflows/pr-review-learn.yml`.

- [ ] **Step 1:** Copy the engine's example workflows. Add `branches: [main]` and the `base.ref` guard, pin the checkouts by SHA, and set the kit SHA to the engine's current HEAD.
- [ ] **Step 2:** Run `node ~/dev/pr-review-kit/bin/pr-review.mjs validate` from the worktree and expect no errors. Run `actionlint` on both files and expect it to be clean (or record that it isn't installed).

### Task 6: Local verification and handoff

- [ ] **Step 1:** Run `node --test .pr-review/checks/test/` and expect all tests to pass. `pnpm test` is not run: it doesn't cover `.claude/` and needs an install.
- [ ] **Step 2: Dry runs.** Run `node ~/dev/pr-review-kit/bin/pr-review.mjs local --project .pr-review --base <b> --head <h>` on:
  - PR #1 (`747b8a6`…`09f238e`), expecting `role-registry`, `prompt-sections` and `prompt-bytes` to route
  - PR #5 (`9fe2d03`…`74ef64e`), expecting `policy-tests` and `policy-loosening` facts
  - `a945089^`…`a945089` (class 2), expecting `carve-outs` facts on the message-stripping exemption

  Then render one hand-written `findings.json` with a security finding and check that the summary shows only the pointer.

- [ ] **Step 3:** Write the runbook (`docs/plans/pr-reviewer-runbook.md`) and finalize the spec.
- [ ] **Step 4:** Have `code-reviewer` and `security-reviewer` review the branch diff, then fix confirmed Critical and High findings.
- [ ] **Step 5:** Commit locally on `chore/pr-review`.
