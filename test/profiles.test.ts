import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildOrchestratorPrompt } from "../src/orchestrator.js";
import { composeTeam, profileChain } from "../src/profiles/compose.js";
import {
  BUILT_IN_PROFILES,
  detectProfileId,
  resolveTeam,
} from "../src/profiles/registry.js";
import type { ProjectProfile } from "../src/profiles/types.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

function compose(...profiles: ProjectProfile[]) {
  const map = new Map(profiles.map((p) => [p.id, p]));
  return composeTeam(profileChain(profiles.at(-1)!.id, map));
}

/** A throwaway directory laid out like the recovery-platform monorepo. */
function fakeMonorepo(): string {
  const root = mkdtempSync(join(tmpdir(), "sdt-monorepo-"));
  mkdirSync(join(root, "recovery-api", "src", "config"), { recursive: true });
  writeFileSync(join(root, "recovery-api", "src", "config", "apps.ts"), "");
  for (const dir of ["regroup/mobile/src", "regroup-archive", "homegroups"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  return root;
}

describe("generic profile", () => {
  it("reproduces the original team definitions exactly", async () => {
    const team = await resolveTeam({ selector: "generic", cwd: tmpdir() });
    assert.deepStrictEqual(
      team.agents,
      JSON.parse(fixture("generic-team.json")),
    );
  });

  it("reproduces the original orchestrator prompt exactly", async () => {
    const team = await resolveTeam({ selector: "generic", cwd: tmpdir() });
    assert.equal(
      buildOrchestratorPrompt(team),
      fixture("generic-orchestrator.txt"),
    );
  });
});

describe("profile detection", () => {
  const root = fakeMonorepo();

  it("picks the most specific matching profile", () => {
    assert.equal(detectProfileId(join(root, "regroup")), "regroup");
    assert.equal(detectProfileId(join(root, "regroup/mobile/src")), "regroup");
    assert.equal(detectProfileId(root), "recovery-platform");
    assert.equal(
      detectProfileId(join(root, "homegroups")),
      "recovery-platform",
    );
  });

  it("matches the regroup directory by segment, not by prefix", () => {
    assert.equal(
      detectProfileId(join(root, "regroup-archive")),
      "recovery-platform",
    );
  });

  it("falls back to generic outside the monorepo", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "sdt-other-"));
    mkdirSync(join(elsewhere, "regroup"));
    assert.equal(detectProfileId(join(elsewhere, "regroup")), "generic");
  });
});

describe("regroup profile", async () => {
  const team = await resolveTeam({ selector: "regroup", cwd: tmpdir() });

  it("inherits from recovery-platform", () => {
    assert.deepEqual(team.chain, ["recovery-platform", "regroup"]);
    assert.match(team.context, /flat monorepo/);
    assert.match(team.context, /phoenix-cleanhouse/);
    assert.ok(team.routing.length >= 7);
  });

  it("adds web-engineer after the base roles", () => {
    const names = Object.keys(team.agents);
    assert.equal(names.at(-1), "web-engineer");
    assert.equal(names.length, 11);
  });

  it("gives every agent a description and a prompt carrying both contexts", () => {
    for (const [name, agent] of Object.entries(team.agents)) {
      assert.ok(agent.description.length > 40, name);
      assert.match(agent.prompt, /## Project: Regroup/, name);
      assert.match(agent.prompt, /Data isolation/, name);
      assert.match(agent.prompt, /Regroup invariants/, name);
    }
  });

  it("specializes the client and server roles", () => {
    const fe = team.agents["frontend-engineer"]!.prompt;
    assert.match(fe, /React Native and TypeScript specialist/);
    assert.match(fe, /Redux Toolkit 2/);
    assert.match(fe, /@stripe\/stripe-react-native/);
    assert.doesNotMatch(fe, /You cannot see a browser/);

    const db = team.agents["database-specialist"]!.prompt;
    assert.match(db, /Cloud Firestore/);
    assert.doesNotMatch(db, /foreign keys/);

    const be = team.agents["backend-engineer"]!.prompt;
    assert.match(be, /Cloud Functions v2/);
    assert.match(be, /Validate every input at the trust boundary/);
  });

  it("accumulates standards across the chain, parent first", () => {
    const qa = team.agents["qa-tester"]!.prompt;
    const platform = qa.indexOf("Mutation-kill counts");
    const product = qa.indexOf("Entitlement-gate tests");
    assert.ok(platform > 0 && product > platform);
  });

  it("extends the manager prompt with project context and routing", () => {
    const prompt = buildOrchestratorPrompt(team);
    assert.match(prompt, /- web-engineer: /);
    assert.match(prompt, /## Project routing/);
    assert.match(prompt, /never to frontend-engineer/);
  });
});

describe("composition", () => {
  const base: ProjectProfile = { id: "base", name: "Base", summary: "s" };

  it("disables a role and overrides tools and model", () => {
    const team = compose(base, {
      id: "child",
      name: "Child",
      summary: "s",
      extends: "base",
      roles: {
        "business-strategist": { enabled: false },
        architect: { tools: ["Read"], model: "haiku" },
      },
    });
    assert.equal(team.agents["business-strategist"], undefined);
    assert.deepEqual(team.agents.architect!.tools, ["Read"]);
    assert.equal(team.agents.architect!.model, "haiku");
  });

  it("lets a child override a scalar its parent set", () => {
    const team = compose(
      { ...base, roles: { architect: { model: "haiku" } } },
      {
        id: "child",
        name: "C",
        summary: "s",
        extends: "base",
        roles: { architect: { model: "opus" } },
      },
    );
    assert.equal(team.agents.architect!.model, "opus");
  });

  it("requires a new role to define description, identity and core", () => {
    assert.throws(
      () =>
        compose({ ...base, roles: { "data-analyst": { expertise: ["SQL"] } } }),
      /must define description, identity and core/,
    );
  });

  it("rejects unknown parents and cycles", () => {
    const orphan = { id: "orphan", name: "O", summary: "s", extends: "nope" };
    assert.throws(() => compose(orphan), /extends unknown profile "nope"/);

    const a = { id: "a", name: "A", summary: "s", extends: "b" };
    const b = { id: "b", name: "B", summary: "s", extends: "a" };
    assert.throws(
      () =>
        profileChain(
          "a",
          new Map([
            ["a", a],
            ["b", b],
          ]),
        ),
      /cycle/,
    );
  });

  it("rejects an unknown built-in id", async () => {
    await assert.rejects(
      resolveTeam({ selector: "no-such-profile", cwd: tmpdir() }),
      /Unknown profile "no-such-profile"/,
    );
  });
});

describe("external profiles", () => {
  it("loads a profile module from a path and lets it extend a built-in", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdt-profile-"));
    const path = join(dir, "mine.ts");
    writeFileSync(
      path,
      `export default {
  id: "mine",
  name: "Mine",
  summary: "test",
  extends: "regroup",
  roles: { "frontend-engineer": { standards: ["Use the house style."] } },
};
`,
    );
    const team = await resolveTeam({ selector: path, cwd: tmpdir() });
    assert.deepEqual(team.chain, ["recovery-platform", "regroup", "mine"]);
    assert.match(
      team.agents["frontend-engineer"]!.prompt,
      /- Use the house style\.$/,
    );
  });

  it("rejects a module without a profile default export", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdt-profile-"));
    const path = join(dir, "bad.ts");
    writeFileSync(path, "export default { id: 1 };\n");
    await assert.rejects(
      resolveTeam({ selector: path, cwd: tmpdir() }),
      /must default-export/,
    );
  });
});

describe("built-in profiles", () => {
  it("all compose without error and have unique ids", () => {
    const ids = BUILT_IN_PROFILES.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) {
      const team = composeTeam(
        profileChain(id, new Map(BUILT_IN_PROFILES.map((p) => [p.id, p]))),
      );
      assert.ok(Object.keys(team.agents).length >= 10, id);
    }
  });
});
