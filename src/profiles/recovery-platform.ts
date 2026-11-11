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
  root: findRecoveryPlatformRoot,
  context: `Recovery Platform is a flat monorepo of independent recovery products plus a shared API. Paths in these instructions are relative to the monorepo root.

| Directory | Product | Firebase project |
| --- | --- | --- |
| \`recovery-api/\` | Cross-app API (Cloud Functions) | \`recovery-platform\` |
| \`homegroups/\` | Homegroups (12-step groups) | \`recovery-connect-cad4b\` |
| \`regroup/\` | Regroup (sober living) | \`phoenix-cleanhouse\` |
| \`detox-recovery/\` | NextStep Recovery (Next.js) | \`nextsteprecovery-1d5c2\` |

Each product has its own Firebase project, Auth and Firestore, and its own CLAUDE.md files (product root, plus \`web/\`, \`mobile/\` and \`functions/\` where they exist). Read the CLAUDE.md files for the area you touch before changing it; they are authoritative over these instructions where the two disagree, except for how a command is spelled: run commands in the forms listed under Commands below, even where a CLAUDE.md uses \`cd <dir> && …\`.

Platform rules that bind every role:
- Data isolation: never query one product's Firestore from another. Cross-product flows (referrals, identity) go through recovery-api (\`recovery-api/CLAUDE.md\`); its app-id registry \`recovery-api/src/config/apps.ts\` is the source of truth. Firebase Auth ID tokens are project-scoped, so cross-product calls are server-to-server.
- Vocabulary differs per product: "meeting" is a 12-step meeting in homegroups but a house meeting in regroup, and regroup's "guest" is a resident. Write \`homegroups:meeting\` / \`regroup:meeting\` when ambiguous. More in \`docs/ecosystem/vocabulary.md\`.
- Privacy: never log PII — names, contact info, health or recovery status — anywhere, including tests and error messages. Log full error objects server-side; return only sanitized messages to clients.
- Secrets: no \`.env\` files or secret values in git; use environment variables or Firebase Secret Manager.
- Emulator ports differ per package; read that package's \`firebase.json\`. recovery-api is offset (functions 5002, firestore 8082, auth 9100). Never run two products' emulators at once.
- Where a jest config sets a coverage floor (recovery-api, homegroups/functions, detox-recovery), it is a ratchet: raise it, never lower it.
- Skip build output and vendor bundles (\`**/public/\`, \`*.min.js\`, \`dist/\`, \`build/\`, \`.next/\`, and the compiled \`recovery-api/lib/\` and \`*/functions/lib/\`) when searching or counting. Other \`lib/\` directories, such as \`detox-recovery/lib/\` and \`recovery-api/src/lib/\`, are hand-written source: search them.

Commands. You run at the monorepo root. Run each package's scripts from there in exactly these forms; unattended runs pre-approve them, and \`cd <dir> && …\` or another spelling is refused:
- recovery-api: \`npm --prefix recovery-api test\`, \`npm --prefix recovery-api run typecheck\`, \`npm --prefix recovery-api run lint\`, \`npm --prefix recovery-api run build\`.
- detox-recovery: \`npm --prefix detox-recovery test\`, \`npm --prefix detox-recovery run typecheck\`, \`npm --prefix detox-recovery run lint\`, \`npm --prefix detox-recovery run build\`.
- homegroups/functions: \`npm --prefix homegroups/functions test\`, \`npm --prefix homegroups/functions run test:rules\` and \`npm --prefix homegroups/functions run test:rules:storage\` (each starts its emulator itself and runs the package's whole test suite under it), \`npm --prefix homegroups/functions run lint\`, \`npm --prefix homegroups/functions run build\`.
- homegroups/mobile: \`npm --prefix homegroups/mobile test\`, \`npm --prefix homegroups/mobile run lint\`.
- Pass Jest options after \`--\`, e.g. \`npm --prefix recovery-api test -- --testPathPattern referrals\`.
- Dependencies are installed before the run. Don't run \`npm install\` or \`npm ci\`; if a package's dependencies are missing, report the run as blocked.
- Git is read-only for the team: \`git status\`, \`git diff\`, \`git log\` and \`git show\` work from the root.

Repository workflow:
- Coverage floors and the commit gates apply when the operator commits your work. New source files over 300 lines are blocked; split by extracting modules.
- Never delete or rename a test file, never reduce the test count, and never add \`.skip\`, \`.only\`, \`.todo\`, \`xit\`, \`xdescribe\` or an \`expect(true)\` / \`expect(1)\` assertion, never rename a test to a path no runner picks up, and never change a \`.snap\` file: the commit gate (\`.claude/agent-gates/verify-diff.sh\`) rejects all of them. Keep a moved test in its original file.
- Follow \`.claude/rules/tdd.md\`: a feature starts with a failing test, a bug fix with a test that reproduces it.
- Reusable procedures live in \`.claude/skills/<name>/SKILL.md\`. Read the relevant one before doing a task it covers (new callables, referral flows, running emulators). Deploy skills are not for the team: deploying is the operator's job.
- The commit-msg hook rejects the bare scopes \`mobile\`, \`web\` and \`functions\`. In the commit message the manager suggests, name the product, e.g. \`fix(regroup-mobile):\`, rather than a domain scope such as \`fix(payments):\`.`,
  // .claude/agents/product-manager.md is the repo's own roadmap agent; the
  // team's product-manager role is used instead, as intended.
  shadowedProjectAgents: ["product-manager"],
  allow: [
    "Bash(git status:*)",
    "Bash(git diff:*)",
    "Bash(git log:*)",
    "Bash(git show:*)",
    "Bash(npm --prefix recovery-api test:*)",
    "Bash(npm --prefix recovery-api run typecheck)",
    "Bash(npm --prefix recovery-api run lint)",
    "Bash(npm --prefix recovery-api run build)",
    "Bash(npm --prefix detox-recovery test:*)",
    "Bash(npm --prefix detox-recovery run typecheck)",
    "Bash(npm --prefix detox-recovery run lint)",
    "Bash(npm --prefix detox-recovery run build)",
    "Bash(npm --prefix homegroups/functions test:*)",
    "Bash(npm --prefix homegroups/functions run test:rules)",
    "Bash(npm --prefix homegroups/functions run test:rules:storage)",
    "Bash(npm --prefix homegroups/functions run lint)",
    "Bash(npm --prefix homegroups/functions run build)",
    "Bash(npm --prefix homegroups/mobile test:*)",
    "Bash(npm --prefix homegroups/mobile run lint)",
  ],
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
