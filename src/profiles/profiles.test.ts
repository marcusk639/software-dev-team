import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadOrchestratorPrompt } from "../orchestrator/index.js";
import { prepareAllowRules } from "../allowlist.js";
import { loadTeam } from "../team.js";
import { composeProfile, genericProfile, profileChain } from "./compose.js";
import {
  BUILT_IN_PROFILES,
  checkProfileRoot,
  detectProfileId,
  resolveProfile,
} from "./registry.js";
import type { ProjectProfile } from "./types.js";

function compose(...profiles: ProjectProfile[]) {
  const map = new Map(profiles.map((p) => [p.id, p]));
  return composeProfile(profileChain(profiles.at(-1)!.id, map));
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
  it("leaves the team and the manager's prompt exactly as built in", async () => {
    const profile = await resolveProfile({
      selector: "generic",
      cwd: tmpdir(),
    });
    assert.deepStrictEqual(loadTeam(new Map(), profile), loadTeam());
    assert.equal(
      loadOrchestratorPrompt(new Map(), profile),
      loadOrchestratorPrompt(),
    );
    for (const agent of Object.values(loadTeam())) {
      assert.doesNotMatch(agent.prompt, /^<project>$/m);
    }
    assert.doesNotMatch(loadOrchestratorPrompt(), /^<project(_routing)?>$/m);
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
  const profile = await resolveProfile({ selector: "regroup", cwd: tmpdir() });
  const team = loadTeam(new Map(), profile);

  it("inherits from recovery-platform", () => {
    assert.deepEqual(profile.chain, ["recovery-platform", "regroup"]);
    assert.match(profile.context, /flat monorepo/);
    assert.match(profile.context, /phoenix-cleanhouse/);
    assert.ok(profile.routing.length >= 7);
  });

  it("adds web-engineer after the team roles, with a pinned model and a turn cap", () => {
    const names = Object.keys(team);
    assert.equal(names.at(-1), "web-engineer");
    assert.equal(names.length, 12);
    assert.equal(team["web-engineer"]!.model, "sonnet");
    assert.ok((team["web-engineer"]!.maxTurns ?? 0) > 0);
  });

  it("gives every agent a description and a <project> section carrying both contexts", () => {
    for (const [name, agent] of Object.entries(team)) {
      assert.ok(agent.description.length > 40, name);
      assert.match(agent.prompt, /^<project>\n## Project: Regroup/m, name);
      assert.match(agent.prompt, /Data isolation/, name);
      assert.match(agent.prompt, /Regroup invariants/, name);
      // The shared conventions still follow, so the report contract holds.
      assert.match(agent.prompt, /^<report_format>$/m, name);
    }
  });

  it("specializes the client and server roles", () => {
    const fe = team["frontend-engineer"]!.prompt;
    assert.match(fe, /React Native and TypeScript specialist/);
    assert.match(fe, /Redux Toolkit 2/);
    assert.match(fe, /@stripe\/stripe-react-native/);
    // core replaces the web-oriented standards and workflow.
    assert.doesNotMatch(fe, /You can't see a browser/);
    assert.doesNotMatch(fe, /^<workflow>$/m);
    assert.match(fe, /^<output_format>$/m);
    assert.match(fe, /^<verification>$/m);

    const db = team["database-specialist"]!.prompt;
    assert.match(db, /Cloud Firestore/);
    assert.doesNotMatch(db, /foreign keys/);

    // An identity alone replaces <role> and keeps the team's standards.
    const be = team["backend-engineer"]!.prompt;
    assert.match(be, /Cloud Functions v2/);
    assert.match(be, /Validate input at the trust boundary/);
    assert.match(be, /^<workflow>$/m);

    const web = team["web-engineer"]!.prompt;
    assert.match(web, /^<role>\nYou are the Web Engineer for Regroup/);
    assert.match(web, /^<output_format>\nAfter the status line/m);
  });

  it("accumulates standards across the chain, parent first", () => {
    const qa = team["qa-tester"]!.prompt;
    const platform = qa.indexOf("Mutation-kill counts");
    const product = qa.indexOf("Entitlement-gate tests");
    assert.ok(platform > 0 && product > platform);
  });

  it("extends the manager prompt with project context and routing", () => {
    const prompt = loadOrchestratorPrompt(new Map(), profile);
    assert.match(prompt, /- web-engineer: /);
    assert.match(prompt, /^<project_routing>$/m);
    assert.match(prompt, /never to frontend-engineer/);
  });

  it("lets the project's own files override the profile", () => {
    const custom = loadTeam(
      new Map([
        ["frontend-engineer", { sections: { project: "Ours instead." } }],
      ]),
      profile,
    );
    const fe = custom["frontend-engineer"]!.prompt;
    assert.match(fe, /^<project>\nOurs instead\.\n<\/project>$/m);
    assert.doesNotMatch(fe, /Regroup invariants/);

    const manager = loadOrchestratorPrompt(
      new Map([["orchestrator", { sections: { project_routing: "None." } }]]),
      profile,
    );
    assert.doesNotMatch(manager, /never to frontend-engineer/);
    assert.match(manager, /Regroup invariants/);
  });
});

describe("composition", () => {
  const base: ProjectProfile = { id: "base", name: "Base", summary: "s" };

  it("disables a role and overrides tools and model", () => {
    const { members } = compose(base, {
      id: "child",
      name: "Child",
      summary: "s",
      extends: "base",
      roles: {
        "business-strategist": { enabled: false },
        architect: { tools: ["Read"], model: "haiku" },
      },
    });
    assert.equal(members["business-strategist"], undefined);
    assert.deepEqual(members.architect!.tools, ["Read"]);
    assert.equal(members.architect!.model, "haiku");
  });

  it("lets a child override a scalar its parent set", () => {
    const { members } = compose(
      { ...base, roles: { architect: { model: "haiku" } } },
      {
        id: "child",
        name: "C",
        summary: "s",
        extends: "base",
        roles: { architect: { model: "opus" } },
      },
    );
    assert.equal(members.architect!.model, "opus");
  });

  it("requires a new role to define description, model, tools, identity and core", () => {
    assert.throws(
      () =>
        compose({ ...base, roles: { "data-analyst": { expertise: ["SQL"] } } }),
      /must define description, model, tools, identity and core/,
    );
  });

  it("refuses a new role with a reserved or built-in agent name", () => {
    const role = {
      description: "d",
      model: "sonnet",
      tools: ["Read"],
      identity: "i",
      core: "c",
    } as const;
    for (const name of ["orchestrator", "team", "manager", "explore", "Web"]) {
      assert.throws(
        () => compose({ ...base, roles: { [name]: role } }),
        /cannot add a role named/,
        name,
      );
    }
  });

  it("gives a new role the turn cap of its tool set", () => {
    const role = {
      description: "d",
      model: "sonnet",
      identity: "i",
      core: "c",
    } as const;
    const { members } = compose({
      ...base,
      roles: {
        reader: { ...role, tools: ["Read"] },
        writer: { ...role, tools: ["Read", "Edit"] },
      },
    });
    assert.ok(members.writer!.maxTurns > members.reader!.maxTurns);
  });

  it("refuses a core for a role whose prompt has no <standards>", () => {
    const profile = compose({
      ...base,
      roles: { "qa-tester": { core: "Test it." } },
    });
    assert.throws(
      () => loadTeam(new Map(), profile),
      /qa-tester prompt has no <standards> section/,
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
      resolveProfile({ selector: "no-such-profile", cwd: tmpdir() }),
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
    const profile = await resolveProfile({ selector: path, cwd: tmpdir() });
    assert.deepEqual(profile.chain, ["recovery-platform", "regroup", "mine"]);
    assert.match(
      loadTeam(new Map(), profile)["frontend-engineer"]!.prompt,
      /^- Use the house style\.\n<\/project>$/m,
    );
  });

  it("rejects a module without a profile default export", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdt-profile-"));
    const path = join(dir, "bad.ts");
    writeFileSync(path, "export default { id: 1 };\n");
    await assert.rejects(
      resolveProfile({ selector: path, cwd: tmpdir() }),
      /must default-export/,
    );
  });
});

describe("built-in profiles", () => {
  it("all render without error and have unique ids", () => {
    const ids = BUILT_IN_PROFILES.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
    const available = new Map(BUILT_IN_PROFILES.map((p) => [p.id, p]));
    for (const id of ids) {
      const profile = composeProfile(profileChain(id, available));
      const team = loadTeam(new Map(), profile);
      loadOrchestratorPrompt(new Map(), profile);
      assert.ok(Object.keys(team).length >= 11, id);
    }
  });

  it("defaults to the generic team", () => {
    assert.deepEqual(genericProfile().chain, ["generic"]);
  });
});

describe("profile root", () => {
  const root = fakeMonorepo();

  it("accepts the monorepo root for recovery-platform and its product profiles", async () => {
    for (const selector of ["recovery-platform", "regroup"]) {
      const profile = await resolveProfile({ selector, cwd: root });
      assert.doesNotThrow(() => checkProfileRoot(profile, root));
    }
  });

  it("refuses a product directory, naming the root and the flags to use instead", async () => {
    const cwd = join(root, "regroup");
    const profile = await resolveProfile({ cwd });
    assert.equal(profile.profile.id, "regroup");
    assert.throws(
      () => checkProfileRoot(profile, cwd),
      (error: Error) =>
        error.message.includes(`--cwd ${root} --profile regroup`) &&
        /relative to the project root/.test(error.message),
    );
  });

  it("refuses a directory outside the project", async () => {
    const profile = await resolveProfile({ selector: "regroup", cwd: tmpdir() });
    assert.throws(() => checkProfileRoot(profile, tmpdir()), /not inside/);
  });

  it("does not constrain a profile without a root", () => {
    assert.doesNotThrow(() => checkProfileRoot(genericProfile(), tmpdir()));
  });
});

describe("profile allow rules", () => {
  it("accumulate parent-first across the chain", () => {
    const profile = compose(
      { id: "base", name: "B", summary: "s", allow: ["Bash(npm --prefix api test:*)"] },
      { id: "child", name: "C", summary: "s", extends: "base", allow: ["Bash(npm --prefix web test:*)"] },
    );
    assert.deepEqual(profile.allow, ["Bash(npm --prefix api test:*)", "Bash(npm --prefix web test:*)"]);
  });

  it("are empty for the generic team", () => {
    assert.deepEqual(genericProfile().allow, []);
  });

  it("pass the same validation as --allow for every built-in profile, with no warnings", () => {
    const available = new Map(BUILT_IN_PROFILES.map((p) => [p.id, p]));
    const cwd = fakeMonorepo();
    for (const { id } of BUILT_IN_PROFILES) {
      const profile = composeProfile(profileChain(id, available));
      const rules = prepareAllowRules([], profile.allow, { cwd });
      assert.deepEqual(rules.warnings, [], id);
    }
  });

  it("give regroup's verification commands, and never a wrapper that runs any script", async () => {
    const { allow } = await resolveProfile({ selector: "regroup", cwd: tmpdir() });
    for (const rule of [
      "Bash(npm --prefix regroup/functions test:*)",
      "Bash(npm --prefix regroup/mobile run typecheck:*)",
      "Bash(npm --prefix recovery-api test:*)",
    ]) {
      assert.ok(allow.includes(rule), rule);
    }
    for (const rule of allow) {
      assert.doesNotMatch(rule, /emulators:exec[^)]*:\*\)$/, rule);
      assert.doesNotMatch(rule, /^Bash\((?:npx|node|bash|sh|cd)\b/, rule);
    }
  });

  it("are applied to a run, before the operator's --allow rules", async () => {
    const { prepareRun } = await import("../orchestrator/index.js");
    const cwd = fakeMonorepo();
    const profile = await resolveProfile({ selector: "regroup", cwd });
    const { queryOptions } = prepareRun({
      task: "t",
      cwd,
      autoApprove: true,
      profile,
      allow: ["Bash(make check)"],
    });
    const tools = queryOptions.allowedTools ?? [];
    assert.ok(tools.includes("Bash(npm --prefix regroup/functions test:*)"));
    assert.ok(tools.indexOf("Bash(make check)") > tools.indexOf("Bash(npm --prefix regroup/functions test:*)"));
  });
});

describe("recovery-platform's own product-manager agent", () => {
  it("is a known shadow, so a --strict run is not flagged for it", async () => {
    const { prepareRun } = await import("../orchestrator/index.js");
    const cwd = fakeMonorepo();
    mkdirSync(join(cwd, ".claude", "agents"), { recursive: true });
    writeFileSync(join(cwd, ".claude/agents/product-manager.md"), "---\nname: product-manager\n---\n");
    const profile = await resolveProfile({ selector: "regroup", cwd });
    const { warnings, notices } = prepareRun({ task: "t", cwd, autoApprove: true, profile });
    assert.ok(!warnings.some((w) => /product-manager/.test(w)), warnings.join("\n"));
    assert.ok(notices.some((n) => /product-manager/.test(n)));
  });
});

