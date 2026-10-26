import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BASE_ALLOWED_TOOLS,
  readRootsFromAllowRules,
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
});

describe("MultiEdit needs a specifier", () => {
  it("rejects a bare MultiEdit rule", () => {
    assert.throws(() => resolveAllowedTools([], ["MultiEdit"]));
  });
});

describe("readRootsFromAllowRules", () => {
  it("reads absolute and home directories from Read/Grep/Glob rules", () => {
    assert.deepEqual(
      readRootsFromAllowRules(
        [
          "Read(//Users/me/notes/**)",
          "Grep(/opt/docs/**)",
          "Glob(~/shared/*)",
          "Read(src/**)",
          "Read(/tmp/*/x/**)",
          "Bash(cat:*)",
        ],
        "/home/me",
      ),
      ["/Users/me/notes", "/opt/docs", "/home/me/shared"],
    );
  });
});
