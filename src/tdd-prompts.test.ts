/**
 * The team works test-first: qa-tester turns the acceptance criteria into
 * failing tests before an engineer starts, engineers make them pass without
 * editing them and write their own unit tests first, and the reviewers check
 * the tests as part of the change. These pin that contract in the prompts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { loadOrchestratorPrompt } from "./orchestrator/index.js";
import { resolveProfile } from "./profiles/registry.js";
import { loadTeam, ROLES } from "./team.js";

const manager = loadOrchestratorPrompt();
const team = loadTeam();
const section = (prompt: string, name: string) =>
  new RegExp(`^<${name}>\\n([\\s\\S]*?)\\n</${name}>$`, "m").exec(
    prompt,
  )?.[1] ?? "";

describe("the manager runs a test-first stage", () => {
  const workflow = section(manager, "workflow");

  it("briefs qa-tester for failing acceptance tests before any engineer starts", () => {
    assert.match(workflow, /Tests first/);
    const first = workflow.indexOf("Tests first");
    assert.ok(
      first > workflow.indexOf("product-manager scopes"),
      "after the specification",
    );
    assert.match(workflow.slice(first), /qa-tester/);
    assert.match(workflow, /fails? for the reason/);
    assert.match(workflow, /pass unchanged/);
  });

  it("names the cases that may skip it, and requires saying so", () => {
    assert.match(workflow, /no behavior to test/);
  });

  it("tells code-reviewer which files are the acceptance tests", () => {
    assert.match(workflow, /acceptance test paths/);
  });

  it("checks red-then-green evidence in the harness record", () => {
    assert.match(
      section(manager, "quality_bar"),
      /failing in qa-tester's test-first delegation and passing after/,
    );
    assert.match(section(manager, "verification"), /test-first/);
  });

  it("reports needs-decision and a suggested commit message", () => {
    const format = section(manager, "output_format");
    assert.match(format, /needs-decision/);
    assert.match(format, /\*\*Commit message\*\*/);
  });
});

describe("every specialist shares the test-first conventions", () => {
  it("in the generic team", () => {
    for (const role of ROLES)
      assert.match(team[role].prompt, /^<test_first>$/m, role);
  });

  it("even where a profile's core replaces a role's workflow", async () => {
    const profile = await resolveProfile({
      selector: "regroup",
      cwd: tmpdir(),
    });
    const regroup = loadTeam(new Map(), profile);
    for (const role of [
      "frontend-engineer",
      "mobile-developer",
      "database-specialist",
      "web-engineer",
    ]) {
      const prompt = regroup[role]!.prompt;
      assert.doesNotMatch(prompt, /^<workflow>$/m, role);
      assert.match(prompt, /^<test_first>$/m, role);
    }
  });

  it("forbids reaching green by editing an acceptance test, and requires seeing a test fail first", () => {
    const conventions = section(team["backend-engineer"].prompt, "test_first");
    assert.match(conventions, /see it fail/);
    assert.match(conventions, /can't edit/);
    assert.match(conventions, /spec gap/);
  });

  it("names deploying and pushing among what the safety layer blocks", () => {
    assert.match(
      section(team["backend-engineer"].prompt, "safety"),
      /deploys, pushes/,
    );
  });
});

describe("qa-tester writes the acceptance tests, end to end where it can", () => {
  const qa = team["qa-tester"].prompt;

  it("has a test-first mode with failing output as its evidence", () => {
    const mode = section(qa, "test_first_brief");
    assert.match(mode, /fails? for the right reason/);
    assert.match(mode, /quote/i);
    assert.match(mode, /end-to-end/);
    assert.match(mode, /written but not run/);
  });
});

describe("code-reviewer reviews the tests as part of the change", () => {
  const skill = readFileSync(
    new URL("../plugin/skills/code-review/SKILL.md", import.meta.url),
    "utf8",
  );

  it("checks that acceptance tests are unchanged and nothing was skipped or weakened", () => {
    assert.match(skill, /acceptance tests/i);
    assert.match(skill, /\.skip/);
    assert.match(skill, /weaken/);
  });
});
