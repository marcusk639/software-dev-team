import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadOrchestratorPrompt } from "./orchestrator/index.js";
import { promptSections } from "./prompts.js";
import { loadTeam, ROLES } from "./team.js";

describe("loadTeam", () => {
  it("loads every built-in prompt unchanged when the project customizes nothing", () => {
    const team = loadTeam();
    assert.deepEqual(Object.keys(team), ROLES);
    for (const role of ROLES) assert.ok(team[role].prompt.length > 0);
  });

  it("applies a project's customization to its role only", () => {
    const base = loadTeam();
    const custom = loadTeam(
      new Map([["qa-tester", { append: "Run pnpm test:ci." }]]),
    );
    assert.equal(
      custom["qa-tester"].prompt,
      `${base["qa-tester"].prompt}\n\n## Instructions from this project\n\nRun pnpm test:ci.`,
    );
    assert.equal(custom.architect.prompt, base.architect.prompt);
  });
});

describe("loadOrchestratorPrompt", () => {
  it("renders the roster into a project's replacement prompt", () => {
    const prompt = loadOrchestratorPrompt(
      new Map([
        [
          "orchestrator",
          { replace: "Our manager.\n{{roster}}", append: "Ship small." },
        ],
      ]),
    );
    assert.match(prompt, /^Our manager\.\n- product-manager: /);
    assert.match(prompt, /## Instructions from this project\n\nShip small\.$/);
  });

  it("does not treat braces in appended text as placeholders", () => {
    const prompt = loadOrchestratorPrompt(
      new Map([["orchestrator", { append: "Use {{handlebars}} templates." }]]),
    );
    assert.match(prompt, /Use \{\{handlebars\}\} templates\.$/);
  });
});

describe("team conventions", () => {
  it("adds the shared conventions to every specialist, after its own prompt", () => {
    const team = loadTeam();
    for (const role of ROLES) {
      assert.match(team[role].prompt, /^<role>\n[\s\S]*\n\n<handoff>\n[\s\S]*\n<\/report_format>$/);
    }
  });

  it("lets a project extend the conventions for every role at once", () => {
    const team = loadTeam(new Map([["team", { append: "We use pnpm." }]]));
    for (const role of ROLES) {
      assert.match(team[role].prompt, /<\/report_format>\n\n## Conventions from this project\n\nWe use pnpm\.$/);
    }
  });

  it("puts a role's own project instructions last", () => {
    const team = loadTeam(
      new Map([
        ["team", { append: "We use pnpm." }],
        ["qa-tester", { append: "Run pnpm test:ci." }],
      ]),
    );
    assert.match(
      team["qa-tester"].prompt,
      /We use pnpm\.\n\n## Instructions from this project\n\nRun pnpm test:ci\.$/,
    );
  });

  it("lets a project replace one section of a role", () => {
    const team = loadTeam(new Map([["qa-tester", { sections: { output_format: "A JSON object." } }]]));
    assert.match(team["qa-tester"].prompt, /<output_format>\nA JSON object\.\n<\/output_format>/);
  });
});

describe("prompt structure", () => {
  it("gives every specialist the sections consumers can override", () => {
    const team = loadTeam();
    for (const role of ROLES) {
      const sections = promptSections(team[role].prompt);
      for (const required of ["role", "output_format", "verification", "handoff", "repository", "safety", "report_format"]) {
        assert.ok(sections.includes(required), `${role} lacks <${required}>`);
      }
    }
  });

  it("gives the orchestrator its sections, with the roster rendered", () => {
    const prompt = loadOrchestratorPrompt();
    for (const required of ["role", "team", "workflow", "delegation_brief", "quality_bar", "safety", "output_format", "verification"]) {
      assert.ok(promptSections(prompt).includes(required), `orchestrator lacks <${required}>`);
    }
    assert.doesNotMatch(prompt, /\{\{/);
  });
});

describe("orchestrator customization guards", () => {
  it("rejects a replacement that drops the roster", () => {
    assert.throws(
      () => loadOrchestratorPrompt(new Map([["orchestrator", { sections: { team: "No roster here." } }]])),
      /\{\{roster\}\}/,
    );
  });

  it("lets a project replace the quality bar without touching the safety rules", () => {
    const prompt = loadOrchestratorPrompt(
      new Map([["orchestrator", { sections: { quality_bar: "Our bar." } }]]),
    );
    assert.match(prompt, /<quality_bar>\nOur bar\.\n<\/quality_bar>/);
    assert.match(prompt, /<safety>\n[\s\S]*refused[\s\S]*\n<\/safety>/);
  });

  it("lets a project replace one convention without dropping the others", () => {
    const team = loadTeam(new Map([["team", { sections: { repository: "Our rules." } }]]));
    assert.match(team["qa-tester"].prompt, /<repository>\nOur rules\.\n<\/repository>/);
    assert.match(team["qa-tester"].prompt, /<safety>\n[\s\S]*\n<\/safety>\n\n<report_format>/);
  });
});

describe("turn caps", () => {
  it("gives every specialist its own turn cap", () => {
    const team = loadTeam();
    for (const role of ROLES) {
      assert.ok((team[role].maxTurns ?? 0) > 0, `${role} has no maxTurns`);
    }
  });
});

describe("code-reviewer", () => {
  it("is on the team, runs on the judge tier, and cannot change code", () => {
    const team = loadTeam();
    const reviewer = team["code-reviewer"];
    assert.equal(reviewer.model, "opus");
    for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
      assert.ok(!reviewer.tools?.includes(tool), `code-reviewer must not have ${tool}`);
    }
    for (const tool of ["Read", "Grep", "Glob", "Bash"]) {
      assert.ok(reviewer.tools?.includes(tool), `code-reviewer needs ${tool}`);
    }
  });

  it("has the review rubric as sections a project can override", () => {
    const sections = promptSections(loadTeam()["code-reviewer"].prompt);
    for (const required of ["role", "approach", "rating", "re_review", "output_format", "verification"]) {
      assert.ok(sections.includes(required), `code-reviewer lacks <${required}>`);
    }
  });

  it("is part of the manager's review loop", () => {
    const prompt = loadOrchestratorPrompt();
    assert.match(prompt, /- code-reviewer: /);
    assert.match(prompt, /<workflow>[\s\S]*code-reviewer[\s\S]*<\/workflow>/);
  });
});
