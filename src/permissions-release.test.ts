/**
 * The team builds and verifies; it never ships. Deploying, publishing,
 * pushing, opening or merging PRs and cloud builds are the operator's (or the
 * outer orchestrator's) job after review, so they are hard-denied however
 * they are launched. A command only mentioned as an argument is not run.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createPolicy, denyReason } from "./permissions.js";

const project = realpathSync(mkdtempSync(join(tmpdir(), "sdt-release-")));
mkdirSync(join(project, "src"));
const policy = createPolicy({
  cwd: project,
  agents: ["qa-tester"],
  pinnedModels: [],
  env: {},
});

const RELEASE =
  /Blocked by the team's safety policy \(deploys, publishes or pushes/;

function denies(commands: string[]) {
  for (const command of commands) {
    it(`denies ${JSON.stringify(command)}`, () => {
      const got = denyReason(policy, "Bash", { command });
      assert.ok(got !== null, "expected a deny");
      assert.match(got, RELEASE);
    });
  }
}

function allows(commands: string[]) {
  for (const command of commands) {
    it(`allows ${JSON.stringify(command)}`, () => {
      const got = denyReason(policy, "Bash", { command });
      assert.equal(got, null, got ?? "");
    });
  }
}

describe("deploys are hard-denied", () => {
  denies([
    "firebase deploy",
    "firebase deploy --only functions:createHouse",
    "firebase --project phoenix-cleanhouse deploy --only firestore:rules",
    "npx firebase deploy",
    "npx -y firebase-tools@13 deploy",
    "pnpm exec firebase deploy",
    "cd regroup/functions && firebase deploy",
    "FIREBASE_TOKEN=x firebase deploy",
    'bash -c "firebase deploy"',
    "firebase hosting:channel:deploy preview",
    "firebase functions:delete stripeWebhook --force",
    "firebase functions:secrets:set STRIPE_KEY",
    "firebase firestore:delete --all-collections",
    "firebase database:remove /users",
    "firebase auth:import users.json",
    "npm run deploy",
    "npm run deploy:functions",
    "npm --prefix regroup/functions run deploy",
    "npm run-script deploy",
    "yarn deploy",
    "pnpm --filter web deploy",
    "gcloud functions deploy f --gen2",
    "gcloud run deploy api --source .",
    "gcloud app deploy",
    "gcloud projects delete my-project",
    "gsutil rm gs://bucket/object",
    "eas build --platform ios",
    "eas submit -p android",
    "eas update --branch production",
    "fastlane ios beta",
    "bundle exec fastlane android deploy",
    "vercel --prod",
    "vercel deploy",
    "railway up",
    "netlify deploy --prod",
    "stripe products create --name x --live",
  ]);
});

describe("pushing, PRs, releases and CI dispatch are hard-denied", () => {
  denies([
    "git push",
    "git push origin hco/42-add-export",
    "git push -u origin feature",
    "git -C . push",
    "git -c core.pager=cat push origin x",
    "gh pr create --fill",
    "gh pr merge 7 --squash",
    "gh release create v1.2.0",
    "gh workflow run deploy.yml",
  ]);
});

describe("building, testing, emulators and reading stay allowed", () => {
  allows([
    "firebase emulators:exec --only firestore,auth 'npm test'",
    'npx firebase emulators:exec --only firestore "npm run test:rules"',
    "firebase emulators:start --only functions",
    "firebase --version",
    "npm run build",
    "npm --prefix regroup/functions test",
    "npm run test -- --runInBand",
    "pnpm test",
    "yarn lint",
    "git status",
    "git log --oneline -5",
    "git diff --stat",
    "git fetch origin",
    'grep -rn "firebase deploy" docs/',
    "rg 'npm run deploy' regroup/",
    "cat regroup/functions/package.json",
    "gh pr view 7",
    "gh pr diff 7",
    "eas --version",
    "stripe listen --forward-to localhost:5001/x",
  ]);
});

describe("review round 1: a separator, a wrapper or a launcher does not hide a release", () => {
  denies([
    // Directly followed by a shell separator, a subshell or a substitution.
    "git push;echo done",
    "git push&&true",
    "git push|cat",
    "(git push)",
    "{ git push;}",
    "echo $(git push)",
    "echo `git push`",
    "git push>/dev/null",
    "firebase deploy;echo",
    "firebase deploy|cat",
    "npm run deploy&&x",
    "gh pr merge 7;x",
    "gcloud run deploy api&&x",
    // env, node and package-manager launchers.
    "env git push",
    "env FOO=1 git push origin x",
    "env -i firebase deploy",
    "env -u HOME git push",
    "node node_modules/.bin/firebase deploy",
    "node ./node_modules/firebase-tools/lib/bin/firebase.js deploy",
    "pnpm firebase deploy",
    "yarn firebase deploy --only hosting",
    // Deploy scripts, however they are named or reached.
    "npm run -w regroup/functions deploy",
    "npm run --silent deploy:rules",
    "npm run firebase:deploy",
    "npm run build:deploy",
    "npm --prefix regroup/mobile run deploy:indexes",
    // gh with global options, and writes through the API.
    "gh -R me/repo pr create --fill",
    "gh --repo=me/repo pr merge 7",
    "gh pr close 7",
    "gh api repos/me/repo/pulls -X POST -f title=x",
    "gh api -X PUT repos/me/repo/pulls/7/merge",
    "gh api repos/me/repo/pulls -f title=x -f head=b",
    "gh api repos/me/repo/actions/workflows/ci.yml/dispatches --method POST",
    "gh api repos/me/repo/releases -F tag_name=v1",
    // More deploy tools and destructive cloud operations.
    "firebase projects:delete p",
    "firebase hosting:disable",
    "firebase functions:config:set stripe.key=x",
    "gcloud builds submit --tag gcr.io/p/i",
    "terraform apply -auto-approve",
    "terraform destroy",
    "kubectl apply -f k8s/",
    "kubectl delete deployment api",
    "docker push registry/app:1",
    "pulumi up --yes",
    "wrangler deploy",
    "serverless deploy",
    "npx cdk deploy",
    "git send-pack origin main",
    "git http-push https://x/y.git main",
  ]);
  allows([
    "npm test -- deploy",
    "npm --prefix regroup/functions test -- --testPathPattern deploy",
    "git log --grep='git push'",
    "git commit -m 'firebase deploy notes'",
    "env FOO=1 npm test",
    "gh pr list",
    "gh pr checks 7",
    "gh api repos/me/repo/pulls",
    "gh api repos/me/repo/pulls/7/files",
    "kubectl get pods",
    "terraform plan",
    "docker build -t app .",
  ]);
});

describe("review round 1: git read commands cannot write files", () => {
  for (const command of [
    "git diff --output=package.json",
    "git log -p --output=x.sh",
    "git show --output=.husky/pre-commit HEAD",
    "git -C . diff --output x",
    "git diff --open-files-in-pager=sh",
  ]) {
    it(`denies ${JSON.stringify(command)}`, () => {
      const got = denyReason(policy, "Bash", { command });
      assert.ok(got !== null, "expected a deny");
    });
  }
  allows(["git diff", "git diff --stat HEAD~1", "git log -p -- src/a.ts", "git show HEAD:src/a.ts"]);
});

describe("review round 1: code that runs outside the run is not the team's to write", () => {
  for (const file_path of [
    ".github/workflows/ci.yml",
    ".github/workflows/deploy.yml",
    ".husky/pre-commit",
    ".githooks/pre-push",
    "scripts/git-hooks/pre-commit",
  ]) {
    it(`denies a file-tool write to ${file_path}`, () => {
      const got = denyReason(policy, "Write", { file_path: join(project, file_path), content: "x" });
      assert.match(got ?? "", /runs outside the team's run/);
    });
  }
  for (const command of [
    "sed -i s/a/b/ .github/workflows/ci.yml",
    "cp /tmp/x .husky/pre-commit",
    "mv x scripts/git-hooks/pre-commit",
  ]) {
    it(`denies the shell write ${JSON.stringify(command)}`, () => {
      assert.ok(denyReason(policy, "Bash", { command }) !== null);
    });
  }
  allows(["cat .github/workflows/ci.yml", "ls scripts/git-hooks", "git diff .github/"]);
  it("still allows other files under .github", () => {
    assert.equal(denyReason(policy, "Write", { file_path: join(project, ".github/CODEOWNERS"), content: "x" }), null);
  });
});


describe("security review: git diff and git grep read only the project", () => {
  // `Bash(git diff:*)` is pre-approved, so these would read outside the
  // project with no approval: git diff compares any two files with
  // --no-index, and switches to it unasked when a path is outside the work tree.
  for (const command of [
    "git diff --no-index /etc/passwd /dev/null",
    "git diff --no-index src/a.ts src/b.ts",
    "git diff /etc/hosts /dev/null",
    "git diff -- /etc/hosts src/a.ts",
    "git diff ~/.config/configstore/firebase-tools.json src/a.ts",
    "git diff ../outside.txt src/a.ts",
    'git diff "$HOME/.bash_history" src/a.ts',
    "git -C / diff etc/passwd dev/null",
    "git -C / diff --no-index etc/passwd /dev/null",
    "git grep --no-index -e token /run/secrets",
    "npm --prefix src test && git diff /etc/hosts /dev/null",
  ]) {
    it(`denies ${JSON.stringify(command)}`, () => {
      assert.match(denyReason(policy, "Bash", { command }) ?? "", /outside the project/);
    });
  }
  allows([
    "git diff",
    "git diff HEAD~1",
    "git diff main..HEAD -- src/a.ts",
    "git diff origin/main...HEAD --stat",
    `git diff -- ${join(project, "src/a.ts")}`,
    "git diff --cached -U5 src",
    "git grep -n token src",
  ]);
});
