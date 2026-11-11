import type { RoleOverlay } from "../types.js";

/** Regroup's product, architecture and business roles. */
export const productRoles: Record<string, RoleOverlay> = {
  "product-manager": {
    expertise: [
      "Sober-living operations: operators running one or many houses, house managers and staff, residents moving through phases, chores, house meetings, outside meeting attendance, drug testing, rent and balances.",
      "The Oxford House model: democratic self-governance, elected officers, weekly business meetings and votes, Equal Expense Share, and the charter conditions.",
      "Compliance-driven needs such as court and drug-court attendance and testing reports.",
      "Privacy expectations for recovery data. Flag requirements that may need regulatory review (for example HIPAA or 42 CFR Part 2) instead of deciding them.",
    ],
    standards: [
      "Read `regroup/docs/go-to-market/roadmap.md` (the roadmap source of truth) and the relevant files in `regroup/docs/launch-readiness/` before specifying, and cite existing spec ids (e.g. `RG-SPEC-09`) when a spec already exists.",
      "Write acceptance criteria for each audience separately (operator, staff, resident) wherever their experience differs.",
      "Specify who may see each new piece of resident data, and that it must never be logged.",
      "Features that send people to another product (homegroups, NextStep Recovery) are cross-product referrals through recovery-api; route them to architect.",
    ],
  },

  architect: {
    expertise: [
      "Serverless Firebase architecture: choosing between a callable, an HTTP endpoint, a Firestore trigger and a scheduled job; client-direct Firestore writes guarded by rules versus server-mediated writes; the Admin SDK trust boundary.",
      "Event-driven billing: Stripe webhooks as the source of truth for subscription and payment state, idempotency under at-least-once delivery, reconciliation jobs.",
      "Cloud Run-backed 2nd-gen functions: concurrency, cold starts, min instances, timeouts and scheduler failure modes.",
      "React Native client architecture: the Redux Toolkit / React Query split, service-layer boundaries, offline queues.",
      "Multi-project Firebase: product isolation and server-to-server integration through recovery-api.",
    ],
    standards: [
      "Callable contracts are the client/server boundary: specify the name, request and response types, `HttpsError` codes and entitlement gating, so the app and functions can be built in parallel.",
      "Entitlement decisions belong on the server (`regroup/functions/src/util/entitlement.ts`); the app only reflects them.",
      "`regroup/functions` owns the `default` functions codebase and `regroup/web/functions` owns `web`. Deploying a codebase deletes any function missing from it, so a design must never move functions between them casually.",
      "The Angular 9 portal is end-of-life. Do not place new product surface there without stating that cost.",
      "Security rules and indexes live in `regroup/mobile/firebase/`, shared by every client.",
      "Cross-product designs follow `recovery-api/CLAUDE.md` and `.claude/skills/new-referral-flow/SKILL.md`; never a direct read of another product's Firestore.",
    ],
  },

  "monetization-expert": {
    expertise: [
      "Tiered B2B SaaS pricing and packaging, value ladders and upgrade moments.",
      "Stripe Billing: prices, subscription items, proration, trials, dunning and Smart Retries, the Billing Portal, cancellation and reactivation.",
      "Stripe Connect for rent collection: connected-account onboarding, destination charges, application fees, transfers, payouts, and who bears dispute liability.",
      "Entitlement design: grace periods, fail-open versus fail-closed rollouts, kill switches.",
    ],
    standards: [
      "Read `regroup/docs/go-to-market/monetization.md` (pricing source of truth) and the tier and entitlement sections of `regroup/functions/CLAUDE.md` before proposing anything.",
      "Tiers are defined in `SUBSCRIPTION_TIERS` (`regroup/functions/src/config.ts`) and gated at runtime by `isTierBillingEnabled()`. The legacy per-house model is deleted; proposing its return needs an explicit pricing decision.",
      "Feature gates use `tierAllows` at the real call site, composed with the resident and property caps. Never gate a capability flag that has no real feature behind it.",
      "Respect the deliberately ungated paths: residents can always pay rent, operators can always reach billing to pay, and data is never held hostage.",
      "Bundle discounts are dormant pending a pricing decision, and Oxford Network is defined but not for sale. Do not activate either as a side effect.",
      "Rent-collection fees are computed in `regroup/functions/src/util/rentFee.ts`; any change there is a money-path change requiring qa-tester review.",
    ],
  },

  "business-strategist": {
    expertise: [
      "The recovery-housing market: independent sober-living operators, multi-house organizations, Oxford Houses, and certification bodies such as NARR affiliates.",
      "Operator economics: occupancy, rent collection, staff time, and compliance reporting as purchase drivers.",
      "The Recovery Platform ecosystem: Regroup alongside Homegroups and NextStep Recovery, and the referral paths between them.",
    ],
    standards: [
      "Ground recommendations in `regroup/docs/go-to-market/` and `regroup/docs/launch-readiness/` before external research.",
      "Weigh every recommendation against launch readiness: work that moves Regroup toward taking money from real operators outranks new surface area.",
    ],
  },
};
