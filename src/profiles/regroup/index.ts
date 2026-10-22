import { relative, resolve, sep } from "node:path";
import { findRecoveryPlatformRoot } from "../recovery-platform.js";
import type { ProjectProfile } from "../types.js";
import { clientRoles } from "./client.js";
import { productRoles } from "./product.js";
import { serverRoles } from "./server.js";

/** True when `cwd` is `regroup/` inside the monorepo, or anywhere below it. */
function insideRegroup(cwd: string): boolean {
  const root = findRecoveryPlatformRoot(cwd);
  if (root === null) return false;
  const [first] = relative(root, resolve(cwd)).split(sep);
  return first === "regroup";
}

export const regroup: ProjectProfile = {
  id: "regroup",
  name: "Regroup (Recovery Platform)",
  summary:
    "Regroup sober-living product: React Native app, Firebase Cloud Functions + Stripe backend, Angular 9 web portal.",
  extends: "recovery-platform",
  detect: insideRegroup,
  context: `### Regroup

Regroup is a sober living house management platform for operators, house staff and residents (residents are called "guests" in code). Firebase project: \`phoenix-cleanhouse\`.

| Area | Path | Stack |
| --- | --- | --- |
| Mobile app | \`regroup/mobile/\` | React Native 0.72 (bare, not Expo), React 18, TypeScript, Redux Toolkit 2, TanStack React Query 5, React Navigation 7, @react-native-firebase 17, @stripe/stripe-react-native |
| Cloud Functions | \`regroup/functions/\` | Firebase Cloud Functions v2 (firebase-functions 7) on Node 22, TypeScript, firebase-admin 13, Stripe incl. Connect, zod 4, SendGrid |
| Web portal | \`regroup/web/\` | Angular 9 (end-of-life) with Angular Universal SSR, @angular/fire, ngx-stripe |
| Rules and indexes | \`regroup/mobile/firebase/\` | Firestore and Storage security rules, \`firestore.indexes.json\`, rules tests |

Read \`regroup/CLAUDE.md\` first, then the CLAUDE.md for the area you touch: \`regroup/mobile/CLAUDE.md\` with \`regroup/mobile/.claude/rules/*.md\`, \`regroup/functions/CLAUDE.md\`, or \`regroup/web/CLAUDE.md\`.

Regroup invariants:
- Stripe amounts are integer US cents (\`50000\` = $500.00); convert only at the UI boundary. Watch the legacy exception: \`payments\` documents store \`amount\` in dollars, while \`guests.rentOwed\` is cents.
- The server is the only authority on entitlement (\`regroup/functions/src/util/entitlement.ts\`). The mobile paywall is user experience, not enforcement.
- Operator billing is a flat 6-tier subscription model (\`SUBSCRIPTION_TIERS\` in \`regroup/functions/src/config.ts\`). The legacy per-house/per-guest model was deleted; do not revive it.
- Drug tests, sobriety dates, phases, staff notes and meeting attendance are sensitive recovery data. Never log them, never expose one resident's data to another, and log only ids and aggregate counts.
- The mobile app's internal codename \`rats\` is tied to store and Firebase configuration; never rename it.
- \`regroup/_legacy/\` is archived; never edit it.`,
  routing: [
    "React Native app features — screens, components, Redux and React Query state, calling Cloud Functions from the client, Stripe payment UI — go to frontend-engineer. mobile-developer takes only the native layer: iOS/Android build configuration, CocoaPods, native modules, permissions, push notifications, patch-package and release configuration.",
    "Anything under regroup/web/ (Angular) goes to web-engineer, never to frontend-engineer.",
    "Cloud Functions, server-side Stripe, webhooks and scheduled jobs go to backend-engineer. Firestore data modeling, composite indexes, security rules and data migrations go to database-specialist.",
    "For a feature spanning the app and Cloud Functions, have architect fix the callable contract first (name, request and response types, error codes, entitlement gating); backend-engineer and frontend-engineer can then build against it in parallel.",
    "Pricing, tiers, feature gating and entitlement: monetization-expert designs, backend-engineer implements, qa-tester verifies.",
  ],
  roles: { ...productRoles, ...clientRoles, ...serverRoles },
};
