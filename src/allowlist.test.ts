import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BASE_ALLOWED_TOOLS, resolveAllowedTools } from "./allowlist.js";

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
