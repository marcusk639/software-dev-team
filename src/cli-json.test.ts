/**
 * Runs the real CLI: under --output json, stdout must hold exactly one JSON
 * object, with the full result shape, whatever goes wrong before the run.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function run(args: string[]) {
  const child = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "" },
  });
  return { code: child.status, stdout: child.stdout, stderr: child.stderr };
}

function singleJson(stdout: string) {
  const lines = stdout.trim().split("\n");
  assert.equal(lines.length, 1, `stdout should be one line, got:\n${stdout}`);
  return JSON.parse(lines[0]!);
}

describe("--output json from the real CLI", () => {
  const empty = mkdtempSync(join(tmpdir(), "sdt-cli-json-"));

  for (const [name, args, pattern] of [
    ["a --cwd that does not exist", ["--cwd", join(empty, "missing"), "x"], /not a directory/],
    ["an unknown profile", ["--profile", "no-such", "--cwd", empty, "x"], /Unknown profile/],
    ["an invalid allow rule", ["--allow", "Bash", "--cwd", empty, "x"], /would grant every Bash call/],
  ] as const) {
    it(`answers ${name} with one error_startup object and exit 2`, () => {
      const { code, stdout, stderr } = run(["--output", "json", "--yes", ...args]);
      assert.equal(code, 2);
      const json = singleJson(stdout);
      assert.equal(json.type, "result");
      assert.equal(json.subtype, "error_startup");
      assert.equal(json.is_error, true);
      assert.match(json.result, pattern);
      assert.doesNotMatch(json.result, /Options\n/, "the help text stays on stderr");
      assert.match(stderr, pattern);
      // The same shape as a finished run's, so a typed reader needs no special case.
      assert.deepEqual(Object.keys(json.team).sort(), [
        "acceptance_tests", "changed_files", "commit_message", "exit_code", "ledger",
        "ledger_faults", "needs_check", "notices", "outcome", "profile", "question",
        "strict", "warning", "warnings",
      ]);
      assert.equal(json.team.outcome, "unknown");
      assert.equal(json.team.exit_code, 2);
    });
  }

  it("refuses an interactive run without a TTY in the same format", () => {
    const { code, stdout } = run(["--output", "json", "--cwd", empty, "x"]);
    assert.equal(code, 2);
    assert.match(singleJson(stdout).result, /No TTY available/);
  });
});

describe("review round 2: a configuration error before the run is a startup error", () => {
  it("exits 2 with error_startup, as documented", () => {
    const cwd = mkdtempSync(join(tmpdir(), "sdt-cli-config-"));
    mkdirSync(join(cwd, ".claude", "dev-team"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "dev-team", "no-such-role.md"), "x\n");
    const { code, stdout } = run(["--output", "json", "--yes", "--cwd", cwd, "x"]);
    assert.equal(code, 2);
    const json = singleJson(stdout);
    assert.equal(json.subtype, "error_startup");
    assert.match(json.result, /does not match a prompt/);
    assert.equal(json.team.exit_code, 2);
  });
});

