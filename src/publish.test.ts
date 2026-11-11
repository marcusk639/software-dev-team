import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { publish, pushEnvironment } from "./publish.js";

const ID = ["-c", "user.email=t@t", "-c", "user.name=t"];
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", [...ID, ...args], { cwd, encoding: "utf8" }).trim();

/** A clone of a bare "GitHub" remote, on main, with one commit pushed. */
function project() {
  const root = mkdtempSync(join(tmpdir(), "sdt-publish-"));
  const remote = join(root, "remote.git");
  const cwd = join(root, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["clone", "-q", remote, cwd], { stdio: "ignore" });
  git(cwd, "switch", "-q", "-c", "main");
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src/a.ts"), "export const a = 1;\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "init");
  git(cwd, "push", "-q", "origin", "main");
  git(cwd, "remote", "set-head", "origin", "main");
  return { cwd, remote };
}

const result = (outcome: string, fields: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: "s-1",
  team: {
    outcome,
    commit_message: "feat(api): add the export endpoint",
    acceptance_tests: ["src/export.test.ts"],
  },
  ...fields,
});

const remoteLog = (remote: string, branch: string) =>
  execFileSync("git", ["log", "--format=%s%n%b", "-1", branch], {
    cwd: remote,
    encoding: "utf8",
  });

describe("publish", () => {
  it("commits a done run's changes on a new branch and pushes it", () => {
    const { cwd, remote } = project();
    writeFileSync(join(cwd, "src/a.ts"), "export const a = 2;\n");
    writeFileSync(join(cwd, "src/export.ts"), "export {};\n");
    const out = publish({
      cwd,
      branch: "hco/42-export",
      result: result("done"),
    });
    assert.equal(out.status, "pushed", out.reason ?? "");
    assert.equal(out.branch, "hco/42-export");
    assert.deepEqual(out.files, ["src/a.ts", "src/export.ts"]);
    assert.match(out.commit ?? "", /^[0-9a-f]{40}$/);
    const log = remoteLog(remote, "hco/42-export");
    assert.match(log, /^feat\(api\): add the export endpoint\n/);
    assert.match(log, /software-dev-team run s-1, outcome done/);
    assert.match(log, /src\/export\.test\.ts/);
    // main on the remote is untouched.
    assert.equal(remoteLog(remote, "main").split("\n")[0], "init");
  });

  it("never publishes to the default branch, by name or by the remote's HEAD", () => {
    const { cwd } = project();
    writeFileSync(join(cwd, "src/a.ts"), "x\n");
    for (const branch of ["main", "master"]) {
      const out = publish({ cwd, branch, result: result("done") });
      assert.equal(out.status, "failed");
      assert.match(out.reason ?? "", /default branch/);
    }
    git(cwd, "push", "-q", "origin", "main:trunk");
    git(cwd, "remote", "set-head", "origin", "trunk");
    assert.match(
      publish({ cwd, branch: "trunk", result: result("done") }).reason ?? "",
      /default branch/,
    );
  });

  it("publishes a partial run only when asked to, and says so in the commit", () => {
    const { cwd, remote } = project();
    writeFileSync(join(cwd, "src/a.ts"), "x\n");
    const skipped = publish({
      cwd,
      branch: "wip/x",
      result: result("partial"),
    });
    assert.equal(skipped.status, "skipped");
    assert.match(skipped.reason ?? "", /partial/);
    const out = publish({
      cwd,
      branch: "wip/x",
      result: result("partial"),
      includePartial: true,
    });
    assert.equal(out.status, "pushed", out.reason ?? "");
    assert.match(remoteLog(remote, "wip/x"), /outcome partial/);
  });

  it("skips a failed run and every outcome that is not done or partial", () => {
    const { cwd } = project();
    writeFileSync(join(cwd, "src/a.ts"), "x\n");
    assert.match(
      publish({ cwd, branch: "b", result: result("done", { is_error: true }) })
        .reason ?? "",
      /failed/,
    );
    for (const outcome of ["blocked", "needs-decision", "unknown"]) {
      const out = publish({
        cwd,
        branch: "b",
        result: result(outcome),
        includePartial: true,
      });
      assert.equal(out.status, "skipped", outcome);
    }
    assert.equal(
      publish({ cwd, branch: "b", result: { type: "nope" } }).status,
      "failed",
    );
  });

  it("skips when the run changed nothing", () => {
    const { cwd } = project();
    const out = publish({ cwd, branch: "b", result: result("done") });
    assert.equal(out.status, "skipped");
    assert.match(out.reason ?? "", /nothing to commit/);
  });

  it("refuses to commit a file that holds secrets, and pushes nothing", () => {
    const { cwd, remote } = project();
    writeFileSync(join(cwd, "src/a.ts"), "x\n");
    writeFileSync(join(cwd, ".env.production"), "KEY=x\n");
    const out = publish({ cwd, branch: "b", result: result("done") });
    assert.equal(out.status, "failed");
    assert.match(out.reason ?? "", /\.env\.production/);
    assert.throws(() =>
      execFileSync("git", ["rev-parse", "--verify", "b"], {
        cwd: remote,
        stdio: "ignore",
      }),
    );
  });

  it("refuses a branch name git would not accept", () => {
    const { cwd } = project();
    writeFileSync(join(cwd, "src/a.ts"), "x\n");
    for (const branch of ["bad..name", "-x", "a b", ""]) {
      assert.equal(
        publish({ cwd, branch, result: result("done") }).status,
        "failed",
        branch,
      );
    }
  });

  it("reports a commit the repository's hooks reject, and pushes nothing", () => {
    const { cwd, remote } = project();
    writeFileSync(
      join(cwd, ".git/hooks/pre-commit"),
      "#!/bin/sh\necho 'TEST-COUNT-DROP' >&2\nexit 1\n",
    );
    chmodSync(join(cwd, ".git/hooks/pre-commit"), 0o755);
    writeFileSync(join(cwd, "src/a.ts"), "x\n");
    const out = publish({ cwd, branch: "b", result: result("done") });
    assert.equal(out.status, "failed");
    assert.match(out.reason ?? "", /TEST-COUNT-DROP/);
    assert.throws(() =>
      execFileSync("git", ["rev-parse", "--verify", "b"], {
        cwd: remote,
        stdio: "ignore",
      }),
    );
  });

  it("never force-pushes over a remote branch with other history", () => {
    const { cwd, remote } = project();
    git(cwd, "switch", "-q", "-c", "other");
    writeFileSync(join(cwd, "src/other.ts"), "o\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "someone else's work");
    git(cwd, "push", "-q", "origin", "other:taken");
    git(cwd, "switch", "-q", "main");
    writeFileSync(join(cwd, "src/a.ts"), "x\n");
    const out = publish({ cwd, branch: "taken", result: result("done") });
    assert.equal(out.status, "failed");
    assert.match(out.reason ?? "", /push/i);
    assert.equal(
      remoteLog(remote, "taken").split("\n")[0],
      "someone else's work",
    );
  });

  it("uses the message it is given over the manager's", () => {
    const { cwd, remote } = project();
    writeFileSync(join(cwd, "src/a.ts"), "x\n");
    publish({
      cwd,
      branch: "b",
      result: result("done"),
      message: "fix(api): reviewed by Marcus",
    });
    assert.match(remoteLog(remote, "b"), /^fix\(api\): reviewed by Marcus\n/);
  });
});

describe("pushEnvironment", () => {
  it("passes a token as an HTTP header through git's environment, never in arguments", () => {
    const env = pushEnvironment("ghs_abc", {});
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(env.GIT_CONFIG_COUNT, "2");
    assert.equal(env.GIT_CONFIG_KEY_0, "credential.helper");
    assert.equal(env.GIT_CONFIG_VALUE_0, "");
    assert.equal(env.GIT_CONFIG_KEY_1, "http.https://github.com/.extraheader");
    assert.equal(
      env.GIT_CONFIG_VALUE_1,
      `AUTHORIZATION: basic ${Buffer.from("x-access-token:ghs_abc").toString("base64")}`,
    );
  });

  it("adds nothing without a token", () => {
    const env = pushEnvironment(undefined, { PATH: "/bin" });
    assert.equal(env.GIT_CONFIG_COUNT, undefined);
    assert.equal(env.PATH, "/bin");
  });
});
