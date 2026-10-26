import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadOrchestratorPrompt } from "./orchestrator/index.js";
import { promptSections } from "./prompts.js";
import { loadTeam, ROLES, TEAM_PLUGIN_DIR, TEAM_PLUGIN_NAME } from "./team.js";

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

  it("keeps literal braces in a replaced section and still fills the roster", () => {
    const prompt = loadOrchestratorPrompt(
      new Map([
        [
          "orchestrator",
          {
            sections: {
              quality_bar: "Templates use {{ name }} and {{x}}; a lone }} too.",
              team: "Our team:\n{{roster}}",
            },
          },
        ],
      ]),
    );
    assert.match(prompt, /<quality_bar>\nTemplates use \{\{ name \}\} and \{\{x\}\}; a lone \}\} too\.\n<\/quality_bar>/);
    assert.match(prompt, /<team>\nOur team:\n- product-manager: /);
  });

  it("still rejects a section override that drops the roster", () => {
    assert.throws(
      () =>
        loadOrchestratorPrompt(
          new Map([["orchestrator", { sections: { team: "{{literal}} only" } }]]),
        ),
      /\{\{roster\}\}/,
    );
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

  it("keeps its own role, output and self-check in the prompt", () => {
    const sections = promptSections(loadTeam()["code-reviewer"].prompt);
    for (const required of ["role", "output_format", "verification"]) {
      assert.ok(sections.includes(required), `code-reviewer lacks <${required}>`);
    }
  });

  it("preloads the review method from the team plugin instead of repeating it", () => {
    const reviewer = loadTeam()["code-reviewer"];
    assert.deepEqual(reviewer.skills, [`${TEAM_PLUGIN_NAME}:code-review`]);
    assert.doesNotMatch(reviewer.prompt, /lowest score × 10/);
  });

  it("is part of the manager's review loop", () => {
    const prompt = loadOrchestratorPrompt();
    assert.match(prompt, /- code-reviewer: /);
    assert.match(prompt, /<workflow>[\s\S]*code-reviewer[\s\S]*<\/workflow>/);
  });
});

describe("team plugin", () => {
  const dir = fileURLToPath(TEAM_PLUGIN_DIR);

  it("has a manifest whose name matches the skill prefix the roles use", () => {
    const manifest = JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8")) as { name: string };
    assert.equal(manifest.name, TEAM_PLUGIN_NAME);
  });

  it("ships every skill a role preloads, under the name the role uses", () => {
    for (const role of ROLES) {
      for (const skill of loadTeam()[role].skills ?? []) {
        const [plugin, name = ""] = skill.split(":");
        assert.equal(plugin, TEAM_PLUGIN_NAME, `${role} preloads ${skill} from another plugin`);
        const text = readFileSync(join(dir, "skills", name, "SKILL.md"), "utf8");
        assert.match(text, new RegExp(`^---\\nname: ${name}\\ndescription: .+\\n---\\n`), `${skill} frontmatter`);
      }
    }
  });

  it("keeps the review rubric in the code-review skill", () => {
    const text = readFileSync(join(dir, "skills", "code-review", "SKILL.md"), "utf8");
    for (const part of ["CRITICAL", "confidence", "85", "lowest score", "re-review"]) {
      assert.match(text, new RegExp(part, "i"), `code-review skill lacks ${part}`);
    }
  });
});

describe("role tool sets", () => {
  it("gives implementers write tools and advisers read-only ones", () => {
    const team = loadTeam();
    const writers = ["backend-engineer", "frontend-engineer", "mobile-developer", "database-specialist", "qa-tester"];
    for (const role of ROLES) {
      const tools = team[role].tools ?? [];
      if (role === "code-reviewer") {
        assert.deepEqual(tools, ["Read", "Grep", "Glob", "Bash"], role);
        assert.equal(team[role].maxTurns, 60, role);
      } else if (writers.includes(role)) {
        assert.deepEqual(tools, ["Read", "Grep", "Glob", "WebSearch", "WebFetch", "Write", "Edit", "Bash"], role);
        assert.equal(team[role].maxTurns, 60, role);
      } else {
        assert.deepEqual(tools, ["Read", "Grep", "Glob", "WebSearch", "WebFetch"], role);
        assert.equal(team[role].maxTurns, 30, role);
      }
    }
  });
});

describe("prompts describe what the harness enforces (I10)", () => {
  it("tells the manager about the harness record and the two kinds of stop", () => {
    const prompt = loadOrchestratorPrompt();
    assert.doesNotMatch(prompt, /even though you have the tools/);
    assert.match(prompt, /harness lets you only read, plan and delegate/);
    assert.match(prompt, /harness record of what that specialist ran/);
    assert.match(prompt, /no allow rule can unlock it/);
  });

  it("tells specialists the write check covers file tools and the shell check is best-effort", () => {
    const prompt = loadTeam()["qa-tester"].prompt;
    assert.match(prompt, /file-tool writes outside the project/);
    assert.match(prompt, /best-effort/);
    assert.match(prompt, /safety layer blocked can't be approved/);
  });
});
