# Known-intentional patterns: do not flag

Each entry here is deliberate and documented. Flag one only if the PR changes the reason it is safe, and then say which reason changed. The first five entries are rulings Marcus made on findings from earlier local review rounds, with their sources.

## Commit and PR messages that name a blocked command are denied

A `git commit -m` or `gh pr create --body` whose text names a blocked command or a protected file is denied. This is the accepted false positive, pinned in `src/permissions-message-false-positives.test.ts`. The workaround is `git commit -F <file>`. Source: `74ef64e`, PR #5 ("I3 withdrawn"). Don't propose stripping message text again without addressing the bypass history in checklist class 2.

## Glob patterns are not screened for secret names

Glob only lists names, so its pattern isn't screened, though its base is still confined to `--cwd`. A Grep with no glob inside `--cwd` is also allowed, and secret files there must be gitignored. Source: `6a07bd6` ("Behavior chosen over main's tests"), PR #4, and the comment in `denyReason` in `src/permissions.ts`.

## `dir/*` read rules outside the project are rejected

They are rejected rather than granted one level, because the policy can only open whole trees. Source: PR #5.

## No-op git editors and `.env.ts` modules are allowed

`GIT_EDITOR=true` or `:`, `-c core.editor=true`, and `.env.ts` and `.env.d.ts` (env-schema modules, not dotenv files) are allowed. Real editors and `.env.local` and the like stay denied. Source: `36ed855`.

## Delegations with any `isolation` are refused

The SDK creates worktrees under `.claude/`, where agents may not write, and remote agents run outside the hooks. Source: `2475ea5`.

## The shell layer is documented as best-effort

The Bash checks are pattern matching, not a sandbox (the `<safety>` section of `src/agents/team/prompt.md`). PR #5 lists the known-gap categories: indirect variable expansion and interpreter one-liners, replay through commands the policy doesn't recognise, some substitution positions, `eval` screening affected by unrelated text, and variable operators beyond `$NAME` and `${NAME}`. A gap that falls in one of these categories is not new. Flag it only when the PR claims to close the category, or widens it. The follow-up the repo itself recommends is an OS-level sandbox.

## Other intentional choices

- `DEFAULT_ALLOWED_TOOLS` in `src/allowlist.ts` is empty on purpose, for teams to fill.
- `settingSources: ["project"]` in `src/orchestrator/index.ts` loads the target repo's hooks and MCP servers. It is a documented trust boundary ("Point --cwd at repos you trust").
- The undocumented built-in-agents env var in `src/orchestrator/index.ts` is used knowingly. The delegation guard enforces the same thing either way.
- The judge roles (qa-tester, code-reviewer, architect) run on opus. The cost is intended (`e3ef368`).
- The policy test suites contain fake credentials, such as an `sk-ant-test-…` value and a short `ghp_…` value, and they write `.env` files into temp projects. These are fixtures. The secret scan already skips `sk-ant-test-<hex>` values (`secrets.allowPatterns`). Any other `secrets` fact on a test line still needs a look, and a real-looking credential anywhere is still a finding.
- `docs/reports/*.md` describe older commits (their header says so). Don't report them as stale.
- PR #3 is a byte-identical re-landing of PR #2.
- `src/permissions/shell.ts` and other large files: the repo has no file-size rule.

<!-- pr-review:learned:begin -->
<!-- pr-review:learned:end -->
