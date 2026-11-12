# Extending the team

How to change what the team knows and does: profiles, roles, tools, pre-approved commands, safety rules, skills and the result contract. Each section lists the files to touch and the tests that will hold you to it. [architecture.md](architecture.md) explains the pieces; this page is the how-to.

**Contents**

1. [Pick the right layer](#1-pick-the-right-layer)
2. [Profiles](#2-profiles)
3. [Adding a role to a profile](#3-adding-a-role-to-a-profile)
4. [Adding a built-in role](#4-adding-a-built-in-role)
5. [Changing a role's tools](#5-changing-a-roles-tools)
6. [Pre-approving a project's commands](#6-pre-approving-a-projects-commands)
7. [Adding a safety rule](#7-adding-a-safety-rule)
8. [Adding a skill](#8-adding-a-skill)
9. [Changing the result contract](#9-changing-the-result-contract)
10. [Contracts to keep in sync](#10-contracts-to-keep-in-sync)

## 1. Pick the right layer

| You want to                                                 | Use                    | Lives in                                                                                    |
| ----------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------- |
| Tune prompts for one repository, without changing this repo | Customization files    | `<target>/.claude/dev-team/` ([usage.md §9](usage.md#9-customizing-the-team-for-a-project)) |
| Teach the team a project's stack, commands and rules        | A profile              | `src/profiles/` (built in), or any module passed with `--profile <path>`                    |
| Add a specialist for one project                            | A role in that profile | The profile's `roles`                                                                       |
| Add a specialist every project gets                         | A built-in role        | `src/agents/<role>/`                                                                        |
| Change what any agent may do                                | The safety layer       | `src/permissions*`, `src/tools.ts`                                                          |

Start at the top of this table and go down only when the layer above can't express the change. Customizations and profiles need no change to the harness.

## 2. Profiles

A profile turns the stack-neutral team into specialists who know one project. It is a plain object (`ProjectProfile` in `src/profiles/types.ts`):

| Field                   | Meaning                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| `id`                    | Used by `--profile` and `extends`.                                                                            |
| `name`, `summary`       | Shown in prompts and by `--profiles`.                                                                         |
| `extends`               | A parent profile's id.                                                                                        |
| `detect(cwd)`           | Optional. True when `--cwd` is this project. Among matches, the longest chain wins.                           |
| `root(cwd)`             | Optional. The project root; the run is refused unless `--cwd` is exactly it. Inherited.                       |
| `context`               | Facts every agent and the manager get.                                                                        |
| `routing`               | Rules the manager applies over its general routing.                                                           |
| `allow`                 | Pre-approved permission rules for the project's own commands ([§6](#6-pre-approving-a-projects-commands)).    |
| `shadowedProjectAgents` | Project agents known to share a team role's name. Their rejection becomes a notice, not a `--strict` warning. |
| `roles`                 | Per-role overlays, keyed by role name.                                                                        |

A role overlay (`RoleOverlay`):

```ts
interface RoleOverlay {
  enabled?: boolean; // false removes the role
  description?: string; // what the manager routes on
  model?: string;
  tools?: readonly ToolName[];
  maxTurns?: number;
  identity?: string; // replaces the <role> section
  core?: string; // replaces <standards> and drops <workflow>, where they don't fit the stack
  outputFormat?: string; // replaces <output_format>
  expertise?: readonly string[]; // technologies and techniques the role is expert in
  standards?: readonly string[]; // project practices it must follow
  context?: string; // paths, commands, gotchas, docs to read first
}
```

**Composition.** Profiles chain with `extends`. Down the chain:

- Scalars (`enabled`, `description`, `model`, `tools`, `maxTurns`, `identity`, `core`, `outputFormat`) are overridden by the child.
- `expertise`, `standards`, `context` and `routing` accumulate parent-first, so a product profile adds to its platform profile instead of repeating it.
- `allow` and `shadowedProjectAgents` accumulate too, de-duplicated.

`core` can't be set on a role whose prompt has no `<standards>`, which rules out qa-tester and code-reviewer.

**Writing good profile material.**

- **Prefer pointers to the project's own docs over copied facts.** "Read `functions/CLAUDE.md` first" stays true; a copied price list goes stale.
- **Put facts every role needs in `context`, and a role's specifics in its overlay.**
- **Write commands in the exact form you'll pre-approve them**, and say so in `context`. Recovery-platform's context tells agents to use `npm --prefix <pkg> …` from the root, because `cd <dir> && …` isn't approved.

### A built-in profile

1. Add `src/profiles/<id>.ts`, or a directory like `src/profiles/regroup/` for a large one.
2. Append it to `BUILT_IN_PROFILES` in `src/profiles/registry.ts`.
3. Run `pnpm start --roles --cwd <project> --profile <id>` to see the result.

`profiles/profiles.test.ts` then renders it with every other built-in, and checks:

- that ids are unique;
- that it has at least 11 members, so a profile that disables a role fails this check until you lower it;
- that its allow rules raise no read-root warnings. Notices, such as a prefix that also matches a blocked form, aren't checked.

Add detection tests if it has `detect`. The test that rejects script runners in allow rules (`Bash(npx:*)` and the like) only checks regroup's composed list, so extend it to cover your profile.

### An external profile

Any `.ts` or `.js` module whose default export is a profile. It may extend a built-in:

```ts
// ../acme/team-profile.ts
export default {
  id: "acme",
  name: "Acme Storefront",
  summary: "Next.js storefront on Postgres",
  context: "Acme is … Read CLAUDE.md first.",
  routing: [
    "Checkout changes go to monetization-expert before backend-engineer.",
  ],
  allow: ["Bash(pnpm test:*)", "Bash(pnpm typecheck)"],
  roles: {
    "frontend-engineer": {
      expertise: [
        "Next.js 15 App Router: server components, server actions, caching …",
      ],
      standards: ["Data fetching goes through `src/lib/api.ts`."],
    },
    "mobile-developer": { enabled: false },
  },
};
```

```bash
pnpm start --profile ../acme/team-profile.ts --cwd ../acme "…"
```

It must export string `id`, `name` and `summary`.

## 3. Adding a role to a profile

A role name in `roles` that isn't a team role defines a new role. It must set `description`, `model`, `tools`, `identity` and `core`. It should set `outputFormat`, so its report has the shape the manager expects. See `web-engineer` in `src/profiles/regroup/client.ts`.

```ts
roles: {
  "data-engineer": {
    description: "Builds and fixes ETL jobs and warehouse models. Use for anything in pipelines/.",
    model: "sonnet",
    tools: IMPLEMENTER,                 // from src/agents/shared.ts
    identity: "You are the data engineer on …",
    core: "- Every model has a test in pipelines/tests …",
    outputFormat: "After the status line: 1. **What changed** … 2. **Evidence** …",
  },
}
```

**Name rules.** The name must:

- match `^[a-z0-9][a-z0-9-]*$`;
- not be `orchestrator`, `team`, `manager` or `unknown`;
- not be a Claude Code built-in agent name.

**What it gets.**

- A place on the manager's roster, after the team roles.
- Permission to be delegated to.
- A pinned model.
- The shared team conventions.
- A customization name (`data-engineer.md` and so on).
- A turn cap: 60 if its tools include Write, Edit or Bash, else 30, unless `maxTurns` says otherwise.

**Tests.** `profiles/profiles.test.ts` covers the required fields, reserved names and the turn-cap default. `orchestrator/wiring.test.ts` covers delegation to a profile role with its model pinned.

## 4. Adding a built-in role

A built-in role is part of every project's team, so add one only when the role makes sense everywhere.

1. **Create `src/agents/<role>/index.ts`** exporting `agent`, built with a helper from `src/agents/shared.ts`:
   ```ts
   import { advisory, type AgentSpec } from "../shared.js";
   export const agent: AgentSpec = {
     description: "What it does. Use when …", // the manager routes on this
     model: "opus",
     ...advisory(), // or implementer(), reviewer()
     promptFile: new URL("./prompt.md", import.meta.url),
   };
   ```
2. **Create `src/agents/<role>/prompt.md`**. It must start with the `<role>` section, and have at least `<output_format>` and `<verification>` too. Add `<standards>` if profiles should be able to replace it with `core`. Don't run a formatter on it: prompt bytes are kept stable.
3. **Register it** in `AGENTS` in `src/agents/index.ts`. Its position there is its roster position. The name can't contain a dot, because customization file names use dots.
4. **Update the routing prose.** These name roles by hand:
   - the manager's `<workflow>` in `src/orchestrator/prompt.md`;
   - other roles' prompts;
   - the profiles' `routing` rules.
5. **Decide whether each built-in profile needs an overlay for it.** Without one, it gets the profile's shared `<project>` context but no specialization.

**Tests that will fail until you update them:**

- `profiles/profiles.test.ts` asserts the regroup team's exact size (12 today). This fails for any new role.
- `team.test.ts` "role tool sets" lists the roles that can write, and special-cases code-reviewer. It fails for a new `implementer()` or `reviewer()` role; an `advisory()` role passes.
- `team.test.ts` "prompt structure" fails if the prompt doesn't start with `<role>`, or lacks `<output_format>` or `<verification>`.

## 5. Changing a role's tools

1. The tool must be a member of the `ToolName` union in `src/tools.ts`; unknown names fail to typecheck.
2. Change the preset in `src/agents/shared.ts`, the role's `index.ts`, or a profile overlay's `tools`.
3. **Classify a new tool**, or a rule meant for it won't apply:

   | If the tool …                          | Add it to                                                                                                                                                                       |
   | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | writes files                           | `WRITE_TOOLS` in `src/tools.ts`                                                                                                                                                 |
   | delegates                              | `DELEGATION_TOOLS`                                                                                                                                                              |
   | may be used by the manager             | `MANAGER_ALLOWED` (read-only tools only)                                                                                                                                        |
   | reads paths                            | `READ_TOOLS` in `src/permissions.ts`                                                                                                                                            |
   | must run in the foreground             | `FOREGROUND_ONLY`                                                                                                                                                               |
   | needs a specifier in allow rules       | `NEEDS_SPECIFIER` in `src/allowlist.ts`                                                                                                                                         |
   | shouldn't be recorded when it succeeds | `NOT_RECORDED` in `src/ledger.ts`. Only read-only tools belong here: anything listed is hidden from the evidence the manager checks, and no contract-map link covers this list. |
   | makes a profile role an implementer    | `WRITES` in `src/profiles/compose.ts`                                                                                                                                           |

**Tests.**

- `team.test.ts` pins the exact tool arrays.
- `permissions.test.ts` and `orchestrator/wiring.test.ts` pin what the manager may use.

## 6. Pre-approving a project's commands

Unattended runs refuse any Bash command no allow rule names. A profile's `allow` list pre-approves the project's own test, typecheck, lint and build commands:

```ts
allow: [
  "Bash(npm --prefix recovery-api test:*)",      // a prefix: test plus any arguments
  "Bash(npm --prefix recovery-api run typecheck)",  // exact
  "Bash(git status:*)",
],
```

**Rules.**

- Name exact commands, or a prefix that only adds arguments to one script.
- Never pre-approve a runner that executes arbitrary code, such as `Bash(npx:*)`, `Bash(node:*)`, `Bash(bash:*)` or a `firebase emulators:exec …:*` prefix. `profiles.test.ts` rejects these in regroup's composed list (which covers recovery-platform too). Extend that test for a new profile.
- Tell the agents the exact spelling, in the profile's `context`. Only that spelling is approved.
- A rule for a command that reads files is a read outside the project unless the safety hook confines it ([security.md S2](security.md)). Check that it does.

Rules are validated like `--allow` ([usage.md §8](usage.md#8-pre-approving-commands---allow)). A rule the safety policy always blocks is an error. `profiles.test.ts` requires built-in profiles' rules to raise no read-root warnings.

## 7. Adding a safety rule

The safety rules are the most sensitive code in the repository. Every change needs tests for the bypass shapes, and an entry in the register.

**Where it goes:**

| To refuse                       | Add to                                                                                                                                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A Bash command                  | `HARD_DENY` in `src/permissions/shell.ts`: `{ pattern, why, normalizedOnly? }`. It is matched against every spelling of the command (`spellings()`). Release commands go in `RELEASE_COMMANDS`. |
| Reading a secret                | `SECRET_PATH` / `SECRET_IN_TEXT` in `src/permissions/paths.ts`, and the shell's `ENV_DUMP` / `SECRET_COMMANDS`                                                                                  |
| A file-tool write to a path     | `PROTECTED_WRITE` or `OUTSIDE_RUN_WRITE` in `src/permissions/paths.ts`, mirrored for the shell in `CONFIG_MENTION` (shell.ts) and `PROTECTED_FAMILIES` (paths.ts)                               |
| Anything else about a tool call | `denyReason` in `src/permissions.ts`                                                                                                                                                            |

**Then:**

1. Test it first ([testing.md §4](testing.md#a-safety-rule)). Write deny cases for the bypass shapes and allow cases for the near misses, and pin the reason text.
2. If the rule changes what agents can do, update the `<safety>` sections of `src/agents/team/prompt.md` and `src/orchestrator/prompt.md`. `tdd-prompts.test.ts` pins some of their wording.
3. Record it in the register in [security.md](security.md). Work through its checklist (§3), which asks:
   - does an allow rule reach the rule's target some other way?
   - are abbreviations and wrappers covered?
   - does anything that runs repository code also hold a credential?
4. Before an SDK upgrade, re-run `pnpm check:sdk-permissions` ([testing.md §7](testing.md#7-live-and-manual-checks)).

## 8. Adding a skill

The team plugin (`plugin/`, named `dev-team`) is loaded on every run, so roles can preload its skills.

1. Create `plugin/skills/<name>/SKILL.md`. It must start with exactly these four lines, in this order, with LF line endings and a one-line description. The test's pattern is strict, so don't add other keys:
   ```markdown
   ---
   name: <name>
   description: <when to use it>
   ---
   ```
2. Add `` `${TEAM_PLUGIN_NAME}:<name>` `` (`dev-team:<name>`) to a built-in role's `skills`, as `src/agents/code-reviewer/index.ts` does for `code-review`. A profile can't add skills: `RoleOverlay` has no `skills` field.

**Tests.** `team.test.ts` checks:

- that the manifest's name equals `TEAM_PLUGIN_NAME`;
- that every preloaded skill exists with that frontmatter;
- that code-reviewer's skills are exactly `["dev-team:code-review"]`. Update that pin if you add one there.

## 9. Changing the result contract

Hermes, `--publish` and any dispatcher read the `--output json` result, so treat a change as an API change. Add fields; don't rename or remove them.

| Touch                                                                                           | Why                                                                                                     |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `JsonResult`, `buildJsonResult`, `buildStartupErrorResult` in `src/report.ts`                   | The shape. A startup error must keep the same shape.                                                    |
| `src/index.ts`                                                                                  | Where the inputs are wired.                                                                             |
| `src/publish.ts`                                                                                | Reads `type`, `is_error`, `session_id`, `team.outcome`, `team.acceptance_tests`, `team.commit_message`. |
| [deployment.md §6](deployment.md#6-the-result-contract) and the `--output` text in `src/cli.ts` | The documented contract.                                                                                |

**Tests.**

- `report.test.ts` checks the top-level and `team` fields.
- `cli-json.test.ts` checks the real process.
- `publish.test.ts` checks the consumer.

## 10. Contracts to keep in sync

Some facts live in two places, such as a list in code and a sentence in a prompt. `.pr-review/contract-map.md` lists each one, so a change to one side prompts a check of the other. The PR reviewer uses the same map.

| Link                | If you change …                         | Also check …                                                                                                                                            |
| ------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `role-registry`     | the keys of `AGENTS`                    | role names in the manager's and roles' prompts, the writers list in `team.test.ts`, the project-agent shadow check, consumers' customization file names |
| `prompt-sections`   | a `<section>` tag                       | every `<name>.<section>.md` that overrides it, and the prompt-structure tests                                                                           |
| `placeholders`      | `{{roster}}`                            | `loadOrchestratorPrompt` and the strict renderer                                                                                                        |
| `plugin-skills`     | code-reviewer's `skills`                | the plugin's name, `SKILL.md` frontmatter, the plugin tests                                                                                             |
| `tool-names`        | `ToolName` or the tool lists            | `READ_TOOLS`, `FOREGROUND_ONLY`, the presets, `NEEDS_SPECIFIER`                                                                                         |
| `ledger-text`       | the ledger's outcome words or rows      | the manager's `<quality_bar>`, the wording tests, `outcome.ts`                                                                                          |
| `report-status`     | the `Status:` vocabulary                | the manager's `<delegation_brief>` and `<output_format>`                                                                                                |
| `protected-paths`   | `PROTECTED_WRITE` or its families       | the shell's `CONFIG_MENTION`, the `<safety>` prompts, `CUSTOMIZATION_DIR`                                                                               |
| `secret-families`   | `SECRET_PATH` / `SECRET_IN_TEXT`        | the glob families, `ENV_DUMP`, `SECRET_COMMANDS`, `CREDENTIAL_NAME`, ledger redaction                                                                   |
| `cli-surface`       | a flag in `parseArgs`                   | `usage()`, exit codes in `index.ts`, `RunOptions`, `outcome.ts`, the prompts' `--allow` examples, `cli.test.ts`                                         |
| `allow-rule-syntax` | `src/allowlist.ts`                      | Claude Code's rule syntax, `approvalReason`, the wiring tests                                                                                           |
| `sdk-assumptions`   | the SDK version                         | the built-in agent names, the disable-agents variable, `settingSources`, `pnpm check:sdk-permissions`                                                   |
| `reserved-names`    | `manager` / `unknown`                   | `RESERVED_NAMES`                                                                                                                                        |
| `prompt-bytes`      | a `prompt.md`                           | `.prettierrc`, `.prettierignore`, `.gitattributes`, `loadPrompt` normalization                                                                          |
| `policy-tests`      | any permission rule                     | the deny/allow tables, the accepted false positives, the [security.md](security.md) register                                                            |
| `test-layouts`      | `isTestPath`                            | qa-tester's `<test_first_brief>`, the lock's wording in the prompts, the deployment guide, `report.ts`/`publish.ts`                                     |
| `review-config`     | `.pr-review/**` or the review workflows | these are reviewer self-edits; see the invariants listed in the map                                                                                     |

Adding a new cross-file contract? Add a section to the map and a matching entry to `.pr-review/routing.json`, then validate the reviewer configuration with the kit's `bin/pr-review.mjs validate`, from a checkout of [pr-review-kit](https://github.com/marcusk639/pr-review-kit) at the commit `.github/workflows/pr-review.yml` pins. The repository's own reviewer checks run with `node --test '.pr-review/checks/test/*.test.mjs'`.
