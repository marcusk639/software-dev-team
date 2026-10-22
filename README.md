# software-dev-team

An autonomous software development team built on the Claude Agent SDK. An Engineering Manager agent decomposes a task and delegates it to specialists (product manager, architect, UX designer, backend, frontend and mobile engineers, database specialist, QA, monetization, strategy). It holds each result to an evidence bar before reporting it done.

The specialists are **configured per project**. A project profile turns the stack-neutral team into specialists who know the project's technologies, conventions, commands and invariants. For example, under the `regroup` profile the frontend engineer is a React Native / Redux Toolkit / React Query / Stripe specialist. The backend engineer becomes a GCP, Cloud Functions v2, Firestore and Stripe Connect specialist.

## Usage

```bash
pnpm install
pnpm start --cwd ../recovery-platform/regroup "Add a CSV export of payment history for operators"

pnpm start --profiles                                   # list built-in profiles
pnpm start --roles --cwd ../recovery-platform/regroup   # show the team that would run there
pnpm start --profile regroup --cwd ../recovery-platform "…"   # pick a profile explicitly
pnpm start --profile ./profiles/acme.ts --cwd ../acme "…"     # use a profile module from disk
```

Without `--profile`, the profile is detected from `--cwd`, and the most specific match wins. Anything under `recovery-platform/regroup/` gets `regroup`. The rest of the monorepo gets `recovery-platform`, and everything else gets `generic` (the original stack-neutral team). The active profile is printed at startup.

Other options: `--yes` (auto-approve tool use; the safety hooks still block destructive commands), `--verbose`, `--max-turns <n>`, `--model <name>`, `--file <task.md>`. The team edits real files in `--cwd`, and loads that repository's `.claude` settings and hooks, so point it only at repositories you trust.

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

`src/roles/base.ts` defines the stack-neutral roles. Each has an `identity` line, a `core` (what it produces, its standards and rules), a model and a tool set. A profile (`src/profiles/types.ts`) overlays them:

```ts
interface RoleOverlay {
  enabled?: boolean;              // false removes the role
  description?: string;           // what the manager routes on
  model?: string;
  tools?: readonly string[];
  identity?: string;              // replaces "You are the …"
  core?: string;                  // replaces the generic standards where they don't fit the stack
  expertise?: readonly string[];  // technologies and techniques the role is expert in
  standards?: readonly string[];  // project practices it must follow
  context?: string;               // paths, commands, gotchas, docs to read first
}
```

A profile also carries shared `context`, which every agent and the manager receive. It can carry `routing` rules that the manager applies over its general routing, and an optional `detect(cwd)`.

Profiles chain with `extends`. Down the chain, scalar fields are overridden by the child. `expertise`, `standards`, `context` and `routing` accumulate parent-first, so a product profile adds to its platform profile rather than repeating it. A role name that is not a base role defines a new role, which must supply `description`, `identity` and `core`.

Each agent's prompt is rendered as: identity, core, `## Project: <name>` (shared context), `## Your role on this project`, `## Specialist expertise`, `## Project standards`. With no profile material the prompt is exactly identity and core, so `generic` reproduces the original team byte for byte (enforced by a test).

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
