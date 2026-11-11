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
| Cloud Functions | \`regroup/functions/\` | Firebase Cloud Functions v2, with some v1 legacy triggers (firebase-functions 7) on Node 22, TypeScript, firebase-admin 13, Stripe incl. Connect, zod 4, SendGrid |
| Web portal | \`regroup/web/\` | Angular 9 (end-of-life) with Angular Universal SSR, @angular/fire, ngx-stripe |
| Rules and indexes | \`regroup/mobile/firebase/\` | Firestore and Storage security rules, \`firestore.indexes.json\`, rules tests |

Read \`regroup/CLAUDE.md\` first, then the CLAUDE.md for the area you touch: \`regroup/mobile/CLAUDE.md\` with \`regroup/mobile/.claude/rules/*.md\`, \`regroup/functions/CLAUDE.md\`, or \`regroup/web/CLAUDE.md\`.

Regroup invariants:
- Stripe amounts are integer US cents (\`50000\` = $500.00); convert only at the UI boundary. Watch the exceptions: \`house.monthlyRent\` and \`house.weeklyRent\` are dollars, while \`guests.rentOwed\` and \`guests.choreFees\` are cents (\`regroup/mobile/src/util/money.ts\` brands them). New \`payments.amount\` writes are cents, but documents from before #82 may hold dollars, mixed and with no unit field, until \`migratePaymentAmountsToCents\` has run: never assume one unit when aggregating payment history, and read that script's header first.
- The server is the only authority on access: \`regroup/functions/src/util/entitlement.ts\` enforces subscription status, and \`tierAllows\` in \`regroup/functions/src/util/tierPricing.ts\` gates tier features. The mobile paywall is user experience, not enforcement. Phase A is in force (a house with no \`subscriptionStatus\` is granted), and some paths are deliberately ungated: read \`.claude/rules/regroup-paywall.md\` before changing either, and don't "fix" an ungated path.
- Operator billing is a flat 6-tier subscription model (\`SUBSCRIPTION_TIERS\` in \`regroup/functions/src/config.ts\`). The legacy per-house/per-guest model was deleted; do not revive it.
- Drug tests, sobriety dates, phases, staff notes and meeting attendance are sensitive recovery data. Never log them, never expose one resident's data to another, and log only ids and aggregate counts.
- The mobile app's internal codename \`rats\` is tied to store and Firebase configuration; never rename it.
- \`regroup/_legacy/\` and \`regroup/mobile/_legacy/\` are archived; never edit them.
- In the mobile app, log only through \`logException\`: never \`console.*\`, and never \`debug-logger.ts\`, which writes whole user objects to device storage.`,
  routing: [
    "React Native app features — screens, components, Redux and React Query state, calling Cloud Functions from the client, Stripe payment UI — go to frontend-engineer. mobile-developer takes only the native layer: iOS/Android build configuration, CocoaPods, native modules, permissions, push notifications, patch-package and release configuration.",
    "Anything under regroup/web/ (Angular) goes to web-engineer, never to frontend-engineer.",
    "Cloud Functions, server-side Stripe, webhooks and scheduled jobs go to backend-engineer. Firestore data modeling, composite indexes, security rules and data migrations go to database-specialist.",
    "For a feature spanning the app and Cloud Functions, have architect fix the callable contract first (name, request and response types, error codes, entitlement gating); backend-engineer and frontend-engineer can then build against it in parallel.",
    "Pricing, tiers, feature gating and entitlement: monetization-expert designs, backend-engineer implements, qa-tester verifies.",
  ],
  allow: [
    "Bash(npm --prefix regroup/functions test:*)",
    "Bash(npm --prefix regroup/functions run build)",
    "Bash(npm --prefix regroup/functions run lint)",
    "Bash(npm --prefix regroup/functions run test:coverage)",
    "Bash(npm --prefix regroup/mobile test:*)",
    "Bash(npm --prefix regroup/mobile run typecheck:*)",
    "Bash(npm --prefix regroup/mobile run lint)",
    "Bash(npm --prefix regroup/e2e test:*)",
    "Bash(regroup/web/node_modules/.bin/tsc --noEmit -p regroup/web/tsconfig.spec.json)",
    // Exact, not a prefix: emulators:exec runs whatever script it is given.
    'Bash(firebase emulators:exec --config regroup/mobile/firebase/firebase.json --only firestore,storage,auth --project demo-test "npm --prefix regroup/mobile run test:rules")',
    'Bash(firebase emulators:exec --config regroup/mobile/firebase/firebase.json --only firestore,auth --project demo-test "npm --prefix regroup/mobile run test:integration -- --forceExit")',
  ],
  roles: { ...productRoles, ...clientRoles, ...serverRoles },
};
