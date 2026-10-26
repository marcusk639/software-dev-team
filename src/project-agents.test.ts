import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { projectAgentNames } from "./project-agents.js";

describe("projectAgentNames", () => {
  it("returns nothing when the project has no agents directory", () => {
    assert.deepEqual(
      projectAgentNames(mkdtempSync(join(tmpdir(), "sdt-agents-"))),
      [],
    );
  });

  it("reads the frontmatter name, falling back to the file name", () => {
    const cwd = mkdtempSync(join(tmpdir(), "sdt-agents-"));
    const dir = join(cwd, ".claude", "agents");
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(
      join(dir, "helper.md"),
      "---\nname: target-helper\ndescription: d\n---\nbody\n",
    );
    writeFileSync(join(dir, "plain.md"), "no frontmatter\n");
    writeFileSync(
      join(dir, "nested", "deep.md"),
      "---\r\nname: 'deep-one'\r\n---\r\n",
    );
    writeFileSync(join(dir, "notes.txt"), "ignored");
    assert.deepEqual(projectAgentNames(cwd).sort(), [
      "deep-one",
      "plain",
      "target-helper",
    ]);
  });
});

describe("projectAgentNames: edge cases", () => {
  it("strips an inline YAML comment from the name and skips non-files", () => {
    const cwd = mkdtempSync(join(tmpdir(), "sdt-agents-"));
    const dir = join(cwd, ".claude", "agents");
    mkdirSync(join(dir, "folder.md"), { recursive: true });
    writeFileSync(join(dir, "helper.md"), "---\nname: target-helper # our helper\n---\n");
    assert.deepEqual(projectAgentNames(cwd), ["target-helper"]);
  });
});
