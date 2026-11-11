# software-dev-team

An autonomous software development team built on the Claude Agent SDK. An Engineering Manager agent decomposes a task and delegates it to specialists (product manager, architect, UX designer, backend, frontend and mobile engineers, database specialist, QA, code reviewer, monetization, strategy). It works test-first: qa-tester turns the acceptance criteria into failing tests before an engineer starts, and only qa-tester can edit those tests. The manager holds each result to an evidence bar (a test seen failing, then passing) before reporting it done.

The specialists are **configured per project**. A project profile turns the stack-neutral team into specialists who know the project's technologies, conventions, commands and invariants. For example, under the `regroup` profile the frontend engineer is a React Native / Redux Toolkit / React Query / Stripe specialist. The backend engineer becomes a GCP, Cloud Functions v2, Firestore and Stripe Connect specialist.

## Usage

```bash
pnpm install
pnpm start --cwd ../recovery-platform --profile regroup "Add a CSV export of payment history for operators"

pnpm start --profiles                                          # list built-in profiles
pnpm start --roles --cwd ../recovery-platform --profile regroup  # show the team that would run there
pnpm start --profile ./profiles/acme.ts --cwd ../acme "…"      # use a profile module from disk
pnpm start --output json --yes --cwd ../recovery-platform --profile regroup --file task.md  # for an orchestrator
```

Without `--profile`, the profile is detected from `--cwd`: the recovery-platform monorepo gets `recovery-platform`, and everything else gets `generic` (the stack-neutral team). The recovery-platform profiles give paths and commands relative to the monorepo root, so they run only with `--cwd` at the root. Name the product with `--profile regroup`. A `--cwd` inside a product directory is refused with the flags to use instead. The active profile is printed at startup.

`pnpm start --help` lists the other options (`--yes`, `--allow`, `--resume`, `--strict`, `--max-turns`, `--max-budget`, …). The team edits real files in `--cwd`, and loads that repository's `.claude` settings and hooks, so point it only at repositories you trust.

A profile is the built-in layer. A project can still customize any prompt with files in `<cwd>/.claude/dev-team/` (see `--help`); those apply on top of the profile.

To run the team unattended in Docker under Hermes, see [docs/deployment.md](docs/deployment.md): the image, the credentials it must and must not get, the `--output json` result contract, and what the team can verify in a container. [docs/reviews/2026-11-10-standalone-readiness.md](docs/reviews/2026-11-10-standalone-readiness.md) is the review behind it.

## Built-in profiles

| Profile | Extends | What it adds |
| --- | --- | --- |
| `generic` | — | Nothing: the stack-neutral team. |
| `recovery-platform` | — | Monorepo-wide rules: product data isolation through recovery-api, per-product vocabulary, PII-free logging, secrets, emulator ports, coverage ratchets, commit and git conventions. |
| `regroup` | `recovery-platform` | Specializes every role for Regroup and adds a `web-engineer` for the Angular 9 portal (role table below). |

Under `regroup`:

| Role | Specialty |
| --- | --- |
| frontend-engineer | React Native 0.72 app: TypeScript, Redux Toolkit 2 vs. React Query 5 state placement, UI component design, React Navigation 7, callables via @react-native-firebase, Stripe PaymentSheet, Formik/Yup, RN Testing Library |
| mobile-developer | Native layer: iOS/Android build config, CocoaPods, native modules, permissions, FCM/notifee push, patch-package, release config |
| web-engineer | Angular 9 + Universal SSR maintenance, ngx-stripe, Karma/Protractor/TSLint |
| backend-engineer | Cloud Functions v2 on Node 22, GCP (Cloud Run, Scheduler, Secret Manager, Logging), firebase-admin Firestore, Stripe Billing + Connect + webhooks, zod |
| database-specialist | Firestore modeling, composite indexes, security rules and rules tests, migration scripts (replaces the SQL-oriented generic standards) |
| qa-tester | The real test commands per package, emulator-backed rules suites, Stripe scenarios, entitlement-gate testing |
| ux-designer, product-manager, architect, monetization-expert, business-strategist | Sober-living domain, Oxford House model, tier and entitlement model, Firebase architecture choices, GTM docs |

## How composition works

`src/agents/` defines the stack-neutral roles: each has a definition (`index.ts`: description, model, tools, turn cap) and a prompt (`prompt.md`) made of `<section>` blocks such as `<role>`, `<standards>`, `<workflow>`, `<output_format>` and `<verification>`. A profile (`src/profiles/types.ts`) overlays them:

```ts
interface RoleOverlay {
  enabled?: boolean;              // false removes the role
  description?: string;           // what the manager routes on
  model?: string;
  tools?: readonly ToolName[];
  maxTurns?: number;
  identity?: string;              // replaces the <role> section
  core?: string;                  // replaces <standards> and drops <workflow>, where they don't fit the stack
  outputFormat?: string;          // replaces <output_format>
  expertise?: readonly string[];  // technologies and techniques the role is expert in
  standards?: readonly string[];  // project practices it must follow
  context?: string;               // paths, commands, gotchas, docs to read first
}
```

A profile also carries shared `context`, which every agent and the manager receive. It can also carry:

- `routing` rules, which the manager applies over its general routing;
- `allow` rules, which pre-approve the project's own test, typecheck and build commands for unattended runs. They are exact commands, never a wrapper that runs any script;
- `root(cwd)`, which makes the run require `--cwd` at the project root;
- `shadowedProjectAgents`: project agents known to share a team role's name, whose rejection is then a notice rather than a `--strict` warning;
- an optional `detect(cwd)`.

Profiles chain with `extends`. Down the chain, scalar fields are overridden by the child. `expertise`, `standards`, `context` and `routing` accumulate parent-first, so a product profile adds to its platform profile rather than repeating it. A role name that is not a team role defines a new role, which must supply `description`, `model`, `tools`, `identity` and `core`, and should supply an `outputFormat` so its report has the shape the manager expects. A new role is on the manager's roster, can be delegated to and has its model pinned by the safety policy, like any team role.

Each agent's prompt is rendered as: its sections with the overlay applied, then a `<project>` section holding `## Project: <name>` (shared context), `## Your role on this project`, `## Specialist expertise` and `## Project standards`, then the project's `.claude/dev-team` customizations and the shared team conventions. The manager's prompt gets `<project>` and `<project_routing>` sections. With no profile material nothing is added, so `generic` is exactly the built-in team (enforced by a test).

## Writing a profile

Prefer pointers to the project's own docs over copied facts. A line like "Read `functions/CLAUDE.md` first" stays true; a copied price list goes stale.

**Built in:** add `src/profiles/<id>.ts` (or a directory, like `regroup/`) and register it in `BUILT_IN_PROFILES` in `src/profiles/registry.ts`.

**External:** any `.ts` or `.js` module whose default export is a profile. It may extend a built-in:

```ts
// ../acme/team-profile.ts
export default {
  id: "acme",
  name: "Acme Storefront",
  summary: "Next.js storefront on Postgres",
  context: "Acme is … Read CLAUDE.md first.",
  routing: ["Checkout changes go to monetization-expert before backend-engineer."],
  roles: {
    "frontend-engineer": {
      expertise: ["Next.js 15 App Router: server components, server actions, caching …"],
      standards: ["Data fetching goes through `src/lib/api.ts`."],
    },
    "mobile-developer": { enabled: false },
  },
};
```

```bash
pnpm start --profile ../acme/team-profile.ts --cwd ../acme "…"
```

## Development

```bash
pnpm typecheck
pnpm test
```
