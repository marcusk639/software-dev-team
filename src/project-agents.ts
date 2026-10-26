import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { ROLES } from "./team.js";

/**
 * Agent types Claude Code ships with (SDK 0.3.283). A project agent with one
 * of these names would put a built-in back on the manager's menu under the
 * policy's project-agent allowance, so it is rejected. Compared ignoring case.
 */
export const BUILT_IN_AGENTS: readonly string[] = [
  "general-purpose",
  "Explore",
  "Plan",
  "statusline-setup",
  "output-style-setup",
  "claude-code-guide",
  "claude",
  "fork",
  "verification",
  "comment-thread-analyst",
];

/** Role names the ledger writes itself (see ledger.ts), compared ignoring case. */
const RESERVED_NAMES: readonly string[] = ["manager", "unknown"];

/** An agent the target repo defines in `.claude/agents`. */
export interface ProjectAgent {
  readonly name: string;
  /** The model its frontmatter sets; the manager may not override it. */
  readonly model?: string | undefined;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const field = (name: string) =>
  new RegExp(`^${name}:\\s*["']?([^"'\\r\\n#]+?)["']?\\s*(#.*)?$`, "m");
const NAME = field("name");
const MODEL = field("model");
const VALID_NAME = /^[A-Za-z0-9][\w-]*$/;

/**
 * The agents the target repo defines in `.claude/agents`. They load with
 * settingSources: ["project"], and the team may delegate to them; the
 * built-in agents stay off limits. A file is skipped, with a warning, when
 * it has no frontmatter name, when its name is a built-in agent, a team
 * role or reserved, when it repeats another file's name, when it cannot be
 * read, or when it is a symlink that leaves `.claude/agents` or cannot be
 * resolved.
 */
export function loadProjectAgents(cwd: string): {
  agents: ProjectAgent[];
  warnings: string[];
} {
  const dir = join(cwd, ".claude", "agents");
  let entries;
  try {
    entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { agents: [], warnings: [] };
    }
    throw error;
  }
  const realDir = realpathSync(dir);
  const builtIns = new Set(BUILT_IN_AGENTS.map((n) => n.toLowerCase()));
  const roles = new Set<string>(ROLES.map((n) => n.toLowerCase()));
  const agents: ProjectAgent[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  const paths = entries
    .filter((entry) => entry.name.endsWith(".md"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  for (const path of paths) {
    const skip = (why: string) =>
      warnings.push(`Project agent ${relative(cwd, path)} is ignored: ${why}`);

    let file: string;
    try {
      file = realpathSync(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      skip(`it cannot be resolved (${code ?? (error as Error).message}).`);
      continue;
    }
    if (!file.startsWith(realDir + sep)) {
      skip("it is a symlink to a file outside .claude/agents.");
      continue;
    }
    let text: string;
    try {
      // A directory named like an agent file.
      if (!statSync(file).isFile()) continue;
      text = readFileSync(file, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      skip(`it cannot be read (${code ?? (error as Error).message}).`);
      continue;
    }

    const frontmatter = FRONTMATTER.exec(text)?.[1];
    if (frontmatter === undefined) {
      skip("it has no frontmatter (--- name: … ---).");
      continue;
    }
    const name = NAME.exec(frontmatter)?.[1]?.trim();
    if (!name) {
      skip("its frontmatter has no name.");
      continue;
    }
    if (!VALID_NAME.test(name)) {
      skip(`its name "${name}" is not a valid agent name.`);
      continue;
    }
    const key = name.toLowerCase();
    if (builtIns.has(key)) {
      skip(`"${name}" is a built-in agent, which the team does not use.`);
      continue;
    }
    if (RESERVED_NAMES.includes(key)) {
      skip(`"${name}" is reserved: the ledger uses it for the manager's own calls and for calls it never saw start.`);
      continue;
    }
    if (roles.has(key)) {
      skip(`"${name}" is a team role; the team's own definition is used.`);
      continue;
    }
    if (seen.has(key)) {
      skip(`another file already defines "${name}".`);
      continue;
    }
    seen.add(key);
    const model = MODEL.exec(frontmatter)?.[1]?.trim();
    agents.push(model ? { name, model } : { name });
  }
  return { agents, warnings };
}
