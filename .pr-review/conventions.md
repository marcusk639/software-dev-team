# Practised conventions

What the code actually does, so a PR that departs from it needs a reason. The repo has no `CLAUDE.md` or `AGENTS.md`, so this file stands in for one. The background is in `docs/reports/pr-reviewer-project-brief.md` §5.

- **Fail closed.** Anything the policy can't evaluate denies: `safeDenyReason`, and the outer `try` in `createSafetyHooks` in `src/permissions.ts`. New checks follow suit.
- **Every fixed bypass is pinned by an exact-input test** that asserts the deny reason, not just "denied". Each review round gets its own file (`src/permissions-round2.test.ts`, `src/permissions-round3.test.ts`, `src/permissions-bypasses.test.ts`, `src/permissions-messages.test.ts`). An accepted false positive goes in `src/permissions-message-false-positives.test.ts` with its ruling.
- **Loosenings are declared.** A PR that allows something previously denied lists it in its description, with a reason (PR #5, "Intentional loosenings").
- **Comments say why**, and cite live-run evidence or the SDK version. A behaviour assumed but not verified is marked "unverified against 0.3.283".
- **Deny reasons and CLI errors say what to do next.** For example, "Delegate again without a model override", and `--cwd` errors name the errno.
- **Tool lists are typed:** `as const satisfies readonly ToolName[]`, from one shared list in `src/tools.ts`.
- **TypeScript is strict** with `exactOptionalPropertyTypes`, so optional fields are written `?: T | undefined`.
- **Prompts are XML-sectioned**, end with a `<verification>` self-check, and are never reformatted (the `prompt-bytes` link). Section and role names are an interface consumers use.
- **The only runtime dependency is the SDK**, pinned exactly. Tests use `node:test` through tsx, with real temp directories and fake credentials.
- **Every role declares a model and a turn cap** (`AgentSpec` in `src/agents/shared.ts`). The judge roles run on opus.
- **Commits** follow conventional format with an optional scope (`fix(cli):`, `docs(prompts):`), a body that says why, and a `Claude-Session:` trailer. PRs land as merge commits, so each commit subject reaches `main`.
- **No file-size rule.** `src/permissions/shell.ts` is about 680 lines.

## Where docs and code disagree

- Role names in the orchestrator prompt's prose are not checked against `ROLES` (noted in PR #1, still true).
- `docs/reports/*.md` describe older commits and say so in their header. That is intended.

<!-- pr-review:learned:begin -->
<!-- pr-review:learned:end -->
