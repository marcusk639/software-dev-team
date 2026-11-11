import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  applyCustomization,
  loadCustomizations,
  promptSections,
  renderPrompt,
} from "./prompts.js";

function projectWith(files: Record<string, string>): string {
  const cwd = mkdtempSync(join(tmpdir(), "sdt-prompts-"));
  const dir = join(cwd, ".claude", "dev-team");
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, name), text);
  }
  return cwd;
}

const NAMES = ["qa-tester", "architect", "orchestrator"];

describe("loadCustomizations", () => {
  it("returns nothing when the project has no dev-team directory", () => {
    const cwd = mkdtempSync(join(tmpdir(), "sdt-prompts-"));
    assert.equal(loadCustomizations(cwd, NAMES).size, 0);
  });

  it("reads append and replace files per role, normalized like built-in prompts", () => {
    const cwd = projectWith({
      "qa-tester.md": "﻿Run pnpm test:ci, not pnpm test.\r\n\r\n",
      "architect.replace.md": "You are our architect.\n",
      "architect.md": "Use ADRs in docs/adr.\n",
      "README.md": "How to customize the team.",
    });
    const custom = loadCustomizations(cwd, NAMES);
    assert.deepEqual(custom.get("qa-tester"), {
      append: "Run pnpm test:ci, not pnpm test.",
    });
    assert.deepEqual(custom.get("architect"), {
      replace: "You are our architect.",
      append: "Use ADRs in docs/adr.",
    });
    assert.equal(custom.has("README"), false);
  });

  it("rejects a file that matches no role, naming the valid ones", () => {
    const cwd = projectWith({ "qa-testr.md": "typo" });
    assert.throws(
      () => loadCustomizations(cwd, NAMES),
      /qa-testr\.md.*qa-tester, architect, orchestrator/s,
    );
  });

  it("rejects an empty customization file", () => {
    const cwd = projectWith({ "qa-tester.md": "\n\n" });
    assert.throws(() => loadCustomizations(cwd, NAMES), /empty/);
  });
});

describe("applyCustomization", () => {
  it("leaves the prompt alone without a customization", () => {
    assert.equal(applyCustomization("Base.", undefined), "Base.");
  });

  it("appends project instructions under their own heading", () => {
    assert.equal(
      applyCustomization("Base.", { append: "Extra." }),
      "Base.\n\n## Instructions from this project\n\nExtra.",
    );
  });

  it("replaces, then appends", () => {
    assert.equal(
      applyCustomization("Base.", { replace: "Ours.", append: "Extra." }),
      "Ours.\n\n## Instructions from this project\n\nExtra.",
    );
  });
});

describe("renderPrompt", () => {
  it("fills known placeholders", () => {
    assert.equal(
      renderPrompt("Team:\n{{roster}}", { roster: "- a" }),
      "Team:\n- a",
    );
  });

  for (const bad of [
    "{{ roster }}",
    "{{missing}}",
    "a {{ b",
    "a }} b",
    "{{__proto__}}x",
  ]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      assert.throws(() => renderPrompt(bad, { roster: "" }));
    });
  }
});

describe("section customization", () => {
  const BASE = "<role>\nYou test.\n</role>\n\n<output_format>\nA table.\n</output_format>";

  it("reads <name>.<section>.md as a section replacement", () => {
    const cwd = projectWith({
      "qa-tester.output_format.md": "A JSON object.\n",
      "qa-tester.role.md": "You test our payments service.",
    });
    assert.deepEqual(loadCustomizations(cwd, NAMES).get("qa-tester"), {
      sections: { output_format: "A JSON object.", role: "You test our payments service." },
    });
  });

  it("replaces only the named section, keeping its tags", () => {
    assert.equal(
      applyCustomization(BASE, { sections: { output_format: "A JSON object." } }),
      "<role>\nYou test.\n</role>\n\n<output_format>\nA JSON object.\n</output_format>",
    );
  });

  it("applies sections to a replaced prompt, then appends", () => {
    assert.equal(
      applyCustomization(BASE, {
        replace: "<role>\nOurs.\n</role>",
        sections: { role: "Ours, edited." },
        append: "Extra.",
      }),
      "<role>\nOurs, edited.\n</role>\n\n## Instructions from this project\n\nExtra.",
    );
  });

  it("rejects a section the prompt does not have, listing the ones it does", () => {
    assert.throws(
      () => applyCustomization(BASE, { sections: { outputformat: "x" } }),
      /outputformat.*role, output_format/s,
    );
  });

  it("uses the heading it is given for appended text", () => {
    assert.equal(
      applyCustomization("Base.", { append: "Extra." }, "Project conventions"),
      "Base.\n\n## Project conventions\n\nExtra.",
    );
  });

  it("lists a prompt's sections", () => {
    assert.deepEqual(promptSections(BASE), ["role", "output_format"]);
  });
});

describe("customization directory hygiene", () => {
  it("ignores dotfiles such as .DS_Store and editor swap files", () => {
    const cwd = projectWith({
      ".DS_Store": "binary",
      ".qa-tester.md.swp": "swap",
      "qa-tester.md": "Run pnpm test:ci.",
    });
    assert.deepEqual([...loadCustomizations(cwd, NAMES).keys()], ["qa-tester"]);
  });

  it("ignores subdirectories, even one named like a prompt", () => {
    const cwd = projectWith({ "qa-tester.md": "Run pnpm test:ci." });
    mkdirSync(join(cwd, ".claude", "dev-team", "architect.md"));
    assert.deepEqual([...loadCustomizations(cwd, NAMES).keys()], ["qa-tester"]);
  });

  it("rejects a file name with extra dots", () => {
    const cwd = projectWith({ "qa-tester.role.extra.md": "x" });
    assert.throws(() => loadCustomizations(cwd, NAMES), /does not match a prompt/);
  });

  it("rejects section text that would close its own section early", () => {
    const base = "<role>\nYou test.\n</role>\n\n<output_format>\nA table.\n</output_format>";
    assert.throws(
      () => applyCustomization(base, { sections: { role: "Mine.\n</role>\nInjected." } }),
      /closing <\/role>/,
    );
  });
});

describe("customization symlinks", () => {
  it("rejects a symlinked customization file rather than skipping it", () => {
    const cwd = projectWith({});
    const target = join(cwd, "shared-qa.md");
    writeFileSync(target, "Run pnpm test:ci.");
    symlinkSync(target, join(cwd, ".claude", "dev-team", "qa-tester.md"));
    assert.throws(() => loadCustomizations(cwd, NAMES), /symlink/);
  });
});
