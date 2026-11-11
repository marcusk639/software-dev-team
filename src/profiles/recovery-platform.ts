import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ProjectProfile } from "./types.js";

/**
 * The monorepo root containing `cwd`, or null. Identified by the cross-app
 * registry, which only this repository has; walking up lets detection work
 * from any package directory or worktree inside it.
 */
export function findRecoveryPlatformRoot(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, "recovery-api", "src", "config", "apps.ts"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export const recoveryPlatform: ProjectProfile = {
  id: "recovery-platform",
  name: "Recovery Platform",
  summary:
    "Monorepo of recovery products plus recovery-api; cross-product rules only. Specialize with a product profile (e.g. regroup).",
  detect: (cwd) => findRecoveryPlatformRoot(cwd) !== null,
  context: `Recovery Platform is a flat monorepo of independent recovery products plus a shared API. Paths in these instructions are relative to the monorepo root.

| Directory | Product | Firebase project |
| --- | --- | --- |
| \`recovery-api/\` | Cross-app API (Cloud Functions) | \`recovery-platform\` |
| \`homegroups/\` | Homegroups (12-step groups) | \`recovery-connect-cad4b\` |
| \`regroup/\` | Regroup (sober living) | \`phoenix-cleanhouse\` |
| \`detox-recovery/\` | NextStep Recovery (Next.js) | \`nextsteprecovery-1d5c2\` |

Each product has its own Firebase project, Auth and Firestore, and its own CLAUDE.md files (product root, plus \`web/\`, \`mobile/\` and \`functions/\` where they exist). Read the CLAUDE.md files for the area you touch before changing it; they are authoritative over these instructions where the two disagree.

Platform rules that bind every role:
- Data isolation: never query one product's Firestore from another. Cross-product flows (referrals, identity) go through recovery-api (\`recovery-api/CLAUDE.md\`); its app-id registry \`recovery-api/src/config/apps.ts\` is the source of truth. Firebase Auth ID tokens are project-scoped, so cross-product calls are server-to-server.
- Vocabulary differs per product: "meeting" is a 12-step meeting in homegroups but a house meeting in regroup, and regroup's "guest" is a resident. Write \`homegroups:meeting\` / \`regroup:meeting\` when ambiguous. More in \`docs/ecosystem/vocabulary.md\`.
- Privacy: never log PII — names, contact info, health or recovery status — anywhere, including tests and error messages. Log full error objects server-side; return only sanitized messages to clients.
- Secrets: no \`.env\` files or secret values in git; use environment variables or Firebase Secret Manager.
- Emulator ports differ per package; read that package's \`firebase.json\`. recovery-api is offset (functions 5002, firestore 8082, auth 9100). Never run two products' emulators at once.
- Coverage floors in the jest configs are ratchets: raise them, never lower them.
- Skip build output and vendor bundles (\`**/public/\`, \`*.min.js\`, \`lib/\`, \`dist/\`, \`build/\`, \`.next/\`) when searching or counting.

Repository workflow:
- Use \`git -C <path> …\`, never \`cd <path> && git …\`.
- Commit-message scopes name the product, e.g. \`fix(regroup-mobile):\`, never a bare \`mobile\`, \`web\` or \`functions\`.
- New source files over 300 lines are blocked by the pre-commit hook; split by extracting modules.
- Never delete or rename a test file, and never reduce the test count: a commit gate blocks it. Keep a moved test in its original file.
- Reusable procedures live in \`.claude/skills/<name>/SKILL.md\`. Read the relevant one before doing a task it covers (new callables, deploy preflight, referral flows, running emulators).`,
  routing: [
    "Work that touches more than one product, or recovery-api, goes to architect first; cross-product data moves only through recovery-api.",
    "Money paths (payments, subscriptions, payouts, refunds) get a qa-tester review that reasons from the domain model, not only from the existing tests passing.",
  ],
  roles: {
    "qa-tester": {
      standards: [
        "Mutation-kill counts measure test coupling, not correctness. On money paths, reason from the domain model about what must be true and test that.",
        "Never weaken an assertion, lower a coverage floor, or delete a failing test to get green.",
      ],
    },
  },
};
