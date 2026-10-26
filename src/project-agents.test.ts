import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadProjectAgents } from "./project-agents.js";

function project() {
  const cwd = mkdtempSync(join(tmpdir(), "sdt-agents-"));
  const dir = join(cwd, ".claude", "agents");
  mkdirSync(dir, { recursive: true });
  return { cwd, dir };
}

const names = (cwd: string) =>
  loadProjectAgents(cwd)
    .agents.map((a) => a.name)
    .sort();

describe("loadProjectAgents", () => {
  it("returns nothing when the project has no agents directory", () => {
    assert.deepEqual(
      loadProjectAgents(mkdtempSync(join(tmpdir(), "sdt-agents-"))),
      { agents: [], warnings: [] },
    );
  });

  it("reads the frontmatter name and model, including nested files", () => {
    const { cwd, dir } = project();
    mkdirSync(join(dir, "nested"));
    writeFileSync(
      join(dir, "helper.md"),
      "---\nname: target-helper\ndescription: d\nmodel: sonnet\n---\nbody\n",
    );
    writeFileSync(
      join(dir, "nested", "deep.md"),
      "---\r\nname: 'deep-one'\r\n---\r\n",
    );
    writeFileSync(join(dir, "notes.txt"), "ignored");
    assert.deepEqual(
      loadProjectAgents(cwd).agents.sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
      [{ name: "deep-one" }, { name: "target-helper", model: "sonnet" }],
    );
  });

  it("strips an inline YAML comment from the name and skips directories", () => {
    const { cwd, dir } = project();
    mkdirSync(join(dir, "folder.md"));
    writeFileSync(
      join(dir, "helper.md"),
      "---\nname: target-helper # our helper\n---\n",
    );
    assert.deepEqual(loadProjectAgents(cwd), {
      agents: [{ name: "target-helper" }],
      warnings: [],
    });
  });
});

describe("loadProjectAgents: rejected definitions (I6)", () => {
  for (const name of [
    "general-purpose",
    "Explore",
    "explore",
    "fork",
    "Plan",
  ]) {
    it(`rejects a project agent named after the built-in ${name}`, () => {
      const { cwd, dir } = project();
      writeFileSync(join(dir, "x.md"), `---\nname: ${name}\n---\n`);
      const { agents, warnings } = loadProjectAgents(cwd);
      assert.deepEqual(agents, []);
      assert.match(warnings[0] ?? "", /built-in agent/);
    });
  }

  it("rejects a project agent that shadows a team role", () => {
    const { cwd, dir } = project();
    writeFileSync(
      join(dir, "qa.md"),
      "---\nname: qa-tester\nmodel: haiku\n---\n",
    );
    const { agents, warnings } = loadProjectAgents(cwd);
    assert.deepEqual(agents, []);
    assert.match(warnings[0] ?? "", /"qa-tester" is a team role/);
  });

  it("warns about a file with no frontmatter or no name instead of using the file name", () => {
    const { cwd, dir } = project();
    writeFileSync(join(dir, "plain.md"), "no frontmatter\n");
    writeFileSync(join(dir, "nameless.md"), "---\ndescription: d\n---\n");
    const { agents, warnings } = loadProjectAgents(cwd);
    assert.deepEqual(agents, []);
    assert.equal(warnings.length, 2);
    assert.ok(warnings.some((w) => /nameless\.md .*no name/.test(w)));
    assert.ok(warnings.some((w) => /plain\.md .*no frontmatter/.test(w)));
  });

  it("rejects a malformed name and a duplicate", () => {
    const { cwd, dir } = project();
    writeFileSync(join(dir, "a.md"), "---\nname: helper\n---\n");
    writeFileSync(join(dir, "b.md"), "---\nname: helper\n---\n");
    writeFileSync(join(dir, "c.md"), "---\nname: bad name!\n---\n");
    const { agents, warnings } = loadProjectAgents(cwd);
    assert.deepEqual(agents, [{ name: "helper" }]);
    assert.ok(warnings.some((w) => /b\.md .*already defines "helper"/.test(w)));
    assert.ok(warnings.some((w) => /c\.md .*not a valid agent name/.test(w)));
  });

  it("follows a symlink that stays inside .claude/agents", () => {
    const { cwd, dir } = project();
    mkdirSync(join(dir, "store"));
    writeFileSync(join(dir, "store", "real.txt"), "---\nname: linked\n---\n");
    symlinkSync(join(dir, "store", "real.txt"), join(dir, "linked.md"));
    assert.deepEqual(names(cwd), ["linked"]);
  });

  it("rejects a symlink that leaves .claude/agents, and a dangling one", () => {
    const { cwd, dir } = project();
    writeFileSync(join(cwd, "outside.md"), "---\nname: outsider\n---\n");
    symlinkSync(join(cwd, "outside.md"), join(dir, "outsider.md"));
    symlinkSync(join(dir, "missing"), join(dir, "dangling.md"));
    const { agents, warnings } = loadProjectAgents(cwd);
    assert.deepEqual(agents, []);
    assert.ok(
      warnings.some((w) => /outsider\.md .*outside \.claude\/agents/.test(w)),
    );
    assert.ok(
      warnings.some((w) => /dangling\.md .*cannot be resolved/.test(w)),
    );
  });
});
