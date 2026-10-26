import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  allowRuleWarnings,
  BASE_ALLOWED_TOOLS,
  prepareAllowRules,
  resolveAllowedTools,
} from "./allowlist.js";

describe("resolveAllowedTools", () => {
  it("always includes the base tools", () => {
    assert.deepEqual(resolveAllowedTools([], []), [...BASE_ALLOWED_TOOLS]);
  });

  it("adds defaults and --allow rules once each, in order", () => {
    assert.deepEqual(
      resolveAllowedTools(
        ["Bash(pnpm test:*)"],
        ["Bash(pnpm lint)", "Bash(pnpm test:*)"],
      ),
      [...BASE_ALLOWED_TOOLS, "Bash(pnpm test:*)", "Bash(pnpm lint)"],
    );
  });

  for (const rule of [
    "Bash(pnpm test:*)",
    "Bash(git status)",
    "WebFetch(domain:docs.example.com)",
    "mcp__db__query",
    "Read",
  ]) {
    it(`accepts ${rule}`, () => {
      assert.doesNotThrow(() => resolveAllowedTools([], [rule]));
    });
  }

  for (const rule of [
    "",
    "Bash(",
    "pnpm test",
    "Bash(pnpm test",
    "(Bash)",
    "Bash()",
    "Bash",
    "Write",
    "Edit",
    "Bash(*)",
    "Bash(:*)",
    "Bash(**)",
    "Write(*)",
    "Edit(**)",
    "Bash( )",
    "Bash(*:*)",
    "Bash(**:*)",
    "Bash(* *)",
    "Bash(?*)",
    "Bash(*,*)",
  ]) {
    it(`rejects ${JSON.stringify(rule)}`, () => {
      assert.throws(() => resolveAllowedTools([], [rule]));
    });
  }

  // Every write tool needs a specifier, not only the ones listed by hand.
  for (const rule of ["MultiEdit", "NotebookEdit", "MultiEdit(*)"]) {
    it(`rejects bare write tool ${JSON.stringify(rule)}`, () => {
      assert.throws(
        () => resolveAllowedTools([], [rule]),
        /would grant every/,
      );
    });
  }

  for (const rule of [
    "Write(/**)",
    "Edit(//**)",
    "Write(~/**)",
    "MultiEdit(/*)",
    "NotebookEdit(//)",
  ]) {
    it(`rejects whole-filesystem rule ${JSON.stringify(rule)}`, () => {
      assert.throws(
        () => resolveAllowedTools([], [rule]),
        /whole filesystem/,
      );
    });
  }

  for (const rule of [
    "Bash(rm -rf:*)",
    "Bash(git push --force:*)",
    "Bash(git reset --hard)",
    "Bash(env)",
    "Bash(printenv:*)",
  ]) {
    it(`rejects ${JSON.stringify(rule)}, which the safety policy always blocks`, () => {
      assert.throws(
        () => resolveAllowedTools([], [rule]),
        /can never take effect/,
      );
    });
  }

  for (const rule of [
    "Write(src/**)",
    "Edit(docs/*.md)",
    "MultiEdit(src/**)",
    "Bash(rm:*)",
    "Bash(git push:*)",
  ]) {
    it(`accepts scoped rule ${rule}`, () => {
      assert.doesNotThrow(() => resolveAllowedTools([], [rule]));
    });
  }
});

describe("allow rules that reach hard-denied commands", () => {
  for (const rule of ["Bash(rm -rf:*)", "Bash(rm -r:*)"]) {
    it(`rejects ${rule}: every command it matches is blocked`, () => {
      assert.throws(() => resolveAllowedTools([], [rule]), /can never take effect/);
    });
  }

  for (const [rule, command] of [
    ["Bash(rm:*)", "rm"],
    ["Bash(rm -f:*)", "rm -f"],
    ["Bash(git push:*)", "git push"],
    ["Bash(git reset:*)", "git reset"],
  ] as const) {
    it(`accepts ${rule} but warns that its blocked forms stay blocked`, () => {
      assert.doesNotThrow(() => resolveAllowedTools([], [rule]));
      const warnings = allowRuleWarnings([rule]);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /stay blocked/);
      assert.ok(warnings[0]!.includes(`such as "${command} -`), warnings[0]!);
    });
  }

  for (const rule of ["Bash(pnpm test:*)", "Bash(git status)", "Read(src/**)", "Bash(ls:*)"]) {
    it(`does not warn about ${rule}`, () => {
      assert.deepEqual(allowRuleWarnings([rule]), []);
    });
  }
});

describe("round 2: prefix rules that also cover allowed commands", () => {
  for (const rule of ["Bash(env:*)", "Bash(git config:*)"]) {
    it(`accepts ${rule} with a warning instead of rejecting it`, () => {
      assert.doesNotThrow(() => resolveAllowedTools([], [rule]));
      const warnings = allowRuleWarnings([rule]);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /stay blocked/);
    });
  }
  for (const rule of ["Bash(env)", "Bash(printenv:*)", "Bash(rm -rf:*)"]) {
    it(`still rejects ${rule}`, () => {
      assert.throws(() => resolveAllowedTools([], [rule]), /can never take effect/);
    });
  }
});

describe("prepareAllowRules: read roots use Claude Code's rule-path syntax", () => {
  // A real layout: the project, a sibling directory, and a fake home above both.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sdt-allow-")));
  const home = join(base, "home");
  const cwd = join(home, "work", "project");
  const other = join(base, "opt", "docs");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(home, "shared"), { recursive: true });
  mkdirSync(other, { recursive: true });
  const prepare = (...rules: string[]) =>
    prepareAllowRules([], rules, { cwd, home });

  it("reads `//path` as absolute and `~/path` as the home directory", () => {
    const { readRoots, warnings } = prepare(
      `Read(/${other}/**)`,
      "Grep(~/shared/**)",
      "Bash(cat:*)",
    );
    assert.deepEqual(readRoots, [other, join(home, "shared")]);
    assert.deepEqual(warnings, []);
  });

  it("reads a single leading `/` and a bare path as relative to --cwd", () => {
    // Claude Code resolves `/opt/docs` against the project, not the filesystem root.
    const { readRoots, warnings } = prepare(
      "Read(/opt/docs/**)",
      "Grep(src/**)",
      "Glob(./lib/**)",
      // The project itself, not the filesystem root.
      "Read(/)",
      "Grep(/)",
    );
    assert.deepEqual(readRoots, []);
    assert.deepEqual(warnings, []);
  });

  for (const rule of [
    "Read(//**)",
    "Read(//)",
    "Grep(//)",
    "Glob(//*)",
    "Read(~)",
    "Read(~/**)",
    "Grep(~/)",
  ]) {
    it(`refuses ${rule}: it opens the filesystem root, home or a parent of the project`, () => {
      assert.throws(() => prepare(rule), /whole filesystem, the home directory or a parent of the project/);
    });
  }

  it("refuses a parent of --cwd", () => {
    assert.throws(
      () => prepare(`Read(/${join(home, "work")}/**)`),
      /a parent of the project/,
    );
    assert.throws(() => prepare(`Grep(/${base}/**)`), /a parent of the project/);
  });

  it("refuses `dir/*` outside the project: the policy cannot grant one level", () => {
    assert.throws(
      () => prepare(`Read(/${other}/*)`),
      (error: Error) =>
        /only the files directly in/.test(error.message) &&
        error.message.includes(`"Read(/${other}/**)"`),
    );
  });

  it("warns about a rule outside the project that names no single directory", () => {
    const { readRoots, warnings } = prepare(`Read(/${base}/*/docs/**)`);
    assert.deepEqual(readRoots, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /names no single directory/);
    assert.match(warnings[0]!, /still need approval/);
  });

  it("keeps Bash prefix-rule warnings in the same list", () => {
    const { warnings, allowedTools } = prepare("Bash(git push:*)");
    assert.ok(allowedTools.includes("Bash(git push:*)"));
    assert.match(warnings.join("\n"), /stay blocked/);
  });
});

describe("MultiEdit needs a specifier", () => {
  it("rejects a bare MultiEdit rule", () => {
    assert.throws(() => resolveAllowedTools([], ["MultiEdit"]));
  });
});
