# Contract map

"If X changes, check Y", for each link type, in both directions. Each `## <linkType>` heading matches one `routing.json` entry. The map is guidance, not truth: confirm every link by reading both sides at the PR head. When a PR adds, moves or retires a link, name the section to update under "Map maintenance".

## role-registry

- **Source:** the keys of `AGENTS` in `src/team.ts`. `ROLES` and the roster derive from them.
- **Other sides:**
  - role names in the routing prose of `src/orchestrator/prompt.md`, in the `<workflow>` and `<verification>` sections
  - mentions of other roles in each `src/agents/<role>/prompt.md`
  - the writers list in `src/team.test.ts`
  - the shadowing check in `src/project-agents.ts`, which rejects project agents named like a role
  - consumers' `.claude/dev-team/<role>*.md` customization files, which fail fast on an unknown name (`src/prompts.ts`)
- **Fails:** the manager routes to a role that no longer exists, and the delegation guard denies it at run time. No test checks the prose (PR #1). The `role-names` fact lists the prompts that still name a removed role.

## prompt-sections

- **Source:** the `<section>` tags in each `prompt.md`. `promptSections` in `src/prompts.ts` reads them.
- **Other sides:**
  - consumers' `<name>.<section>.md` overrides, which are rejected when the section doesn't exist (`customizeBody` in `src/prompts.ts`)
  - the required sections asserted in `src/team.test.ts` ("prompt structure")
- **Fails:** renaming or removing a section breaks every override of it. The `prompt-sections` fact marks these.

## placeholders

- **Source:** `{{roster}}` in `src/orchestrator/prompt.md`.
- **Other sides:**
  - `loadOrchestratorPrompt` in `src/orchestrator/index.ts`, which requires the roster and fills it in section overrides only
  - the strict `renderPrompt` in `src/prompts.ts`, which rejects unknown, malformed and prototype-key placeholders
- **Fails:** a new placeholder with no value, or a dropped roster, throws at run start.

## plugin-skills

- **Source:** `skills: [...]` in `src/agents/code-reviewer/index.ts`, written as `${TEAM_PLUGIN_NAME}:<skill>`.
- **Other sides:**
  - `name` in `plugin/.claude-plugin/plugin.json`
  - frontmatter `name` in `plugin/skills/code-review/SKILL.md`
  - `TEAM_PLUGIN_NAME` and `TEAM_PLUGIN_DIR` in `src/agents/shared.ts`
  - the "team plugin" tests in `src/team.test.ts`
- **Fails:** the skill doesn't preload, and the reviewer role runs without its method.

## tool-names

- **Source:** the `ToolName` union and the `WRITE_TOOLS`, `DELEGATION_TOOLS` and `MANAGER_ALLOWED` lists in `src/tools.ts`.
- **Other sides:**
  - `READ_TOOLS` and `FOREGROUND_ONLY` in `src/permissions.ts`
  - `READ_ONLY`, `IMPLEMENTER` and `REVIEWER` in `src/agents/shared.ts`
  - `NEEDS_SPECIFIER` in `src/allowlist.ts`
  - the SDK's own tool names, which are external
- **Fails:** a tool that writes, reads or delegates but is missing from the right list escapes the rule meant for it. The `satisfies` checks cover only names already in the union. The `tool-lists` fact lists the changes.

## ledger-text

- **Source:** the strings `src/ledger.ts` emits: outcome words (`ok`, `failed`, `blocked`, `refused`, `started`), the "more earlier calls that ended ok" row, and "Harness record unavailable".
- **Other sides:**
  - the `<quality_bar>` section of `src/orchestrator/prompt.md`, which tells the manager how to read them
  - the prompt-wording tests in `src/team.test.ts`
  - `ledgerConcerns` and `runOutcome` in `src/outcome.ts`
- **Fails:** the manager counts an unverified claim as verified, or the reverse.

## report-status

- **Source:** the status vocabulary (`done`, `partial`, `blocked`, `needs-decision`) in the `<report_format>` section of `src/agents/team/prompt.md`.
- **Other side:** `src/orchestrator/prompt.md`, in the `<delegation_brief>` and `<output_format>` sections.
- **Fails:** the manager acts on a status word specialists no longer emit.

## protected-paths

- **Source:** `PROTECTED_WRITE` and `PROTECTED_FAMILIES` in `src/permissions/paths.ts`.
- **Other sides:**
  - `CONFIG_MENTION` in `src/permissions/shell.ts`
  - the `<safety>` sections of `src/agents/team/prompt.md` and `src/orchestrator/prompt.md`
  - `CUSTOMIZATION_DIR` in `src/prompts.ts`, which sits under `.claude/` and so relies on agents being unable to write there
- **Fails:** a path protected from the file tools but not from the shell, or the reverse, is writable by one route. Prompts drift from the list.

## secret-families

- **Source:** `SECRET_PATH` and `SECRET_IN_TEXT` in `src/permissions/paths.ts`.
- **Other sides:**
  - the glob families in `src/permissions/globs.ts`
  - `ENV_DUMP` and `SECRET_COMMANDS` in `src/permissions/shell.ts`
  - `CREDENTIAL_NAME` and `MIN_SECRET_LENGTH` in `src/permissions.ts`
  - the ledger's redaction of `policy.secretValues` in `src/ledger.ts`
- **Fails:** a secret name added for one tool is still reachable through another. That is class 5, and security-relevant.

## cli-surface

- **Source:** the flags in `parseArgs` in `src/cli.ts`.
- **Other sides:**
  - `usage()` in `src/cli.ts`
  - the dispatch and exit codes in `src/index.ts`
  - `RunOptions` in `src/orchestrator/index.ts`
  - `STRICT_EXIT` and `runOutcome` in `src/outcome.ts`
  - the `--allow` examples in both prompts' `<safety>` sections
  - the pins in `src/cli.test.ts`
- **Fails:** help or prompt text describes a flag, a default or an exit code the code doesn't implement.

## allow-rule-syntax

- **Source:** the rule parsing and read roots in `src/allowlist.ts` (`prepareAllowRules`, `rulePath`, `readRuleRoot`).
- **Other sides:**
  - Claude Code's own rule syntax, which the SDK applies to `allowedTools` (external: `//` is absolute, `~/` is home, `/` and bare paths are relative to the project)
  - `approvalReason` in `src/permissions.ts`
  - the usage text and the wiring tests in `src/orchestrator/wiring.test.ts`
- **Fails:** the harness and the SDK disagree on what a rule opens (`d4be76b`).

## sdk-assumptions

- **Source:** the pinned `@anthropic-ai/claude-agent-sdk` version in `package.json`.
- **Other sides:**
  - `BUILT_IN_AGENTS` in `src/project-agents.ts`
  - the built-in-agents env var and `settingSources` in `src/orchestrator/index.ts`
  - every comment marked "unverified against 0.3.283" or "verified against 0.3.283"
  - the acceptEdits command list in the `--yes` usage text and in `src/cli.test.ts`
- **Fails:** an SDK change silently invalidates behaviour a safety or ledger rule relies on. The `sdk-pin` fact lists the files that name the old version.

## reserved-names

- **Source:** the role names the ledger writes for itself (`manager`, `unknown`) in `src/ledger.ts`.
- **Other side:** `RESERVED_NAMES` in `src/project-agents.ts`.
- **Fails:** a project agent with a reserved name can't be told apart from the manager in the ledger.

## prompt-bytes

- **Source:** the bytes of `src/**/prompt.md`.
- **Other sides:**
  - the `requirePragma` override in `.prettierrc`
  - `.prettierignore`
  - `*.md text eol=lf` in `.gitattributes`
  - `loadPrompt`'s normalization in `src/prompts.ts`
- **Fails:** formatting or line-ending changes alter what the model reads and invalidate the prompt cache (`09f238e`). A prompt file outside `src/**/prompt.md` doesn't get the override.

## policy-tests

- **Source:** the rules in `src/permissions/**`, `src/permissions.ts` and `src/allowlist.ts`.
- **Other sides:**
  - the `denies`, `allows` and `check` case tables in the policy suites (`src/permissions.test.ts`, `src/permissions-bypasses.test.ts`, `src/permissions-round2.test.ts`, `src/permissions-round3.test.ts`, `src/permissions-messages.test.ts`)
  - the accepted false positives in `src/permissions-message-false-positives.test.ts`
  - `src/allowlist.test.ts`
- **Fails:** a rule change that loosens without a test moving, or a test that moves without the PR text declaring it. The `policy-loosening` and `carve-outs` facts are the starting points.

## review-config

- `.claude/pr-review/**`, `.github/workflows/pr-review.yml` and `.github/workflows/pr-review-learn.yml` are the reviewer itself. Any change is a self-edit (the kit's procedure). Check that the workflow keeps all of these:
  - the main-only base filter and the `base.ref` guard
  - same-repo, draft and Dependabot guards
  - `contents: read`
  - every secret passed only to the step that needs it
  - one full kit SHA, the same in every `uses:` line
  - SHA-pinned third-party actions

<!-- pr-review:learned:begin -->
<!-- pr-review:learned:end -->
