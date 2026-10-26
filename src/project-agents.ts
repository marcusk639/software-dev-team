import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const NAME = /^name:\s*["']?([^"'\r\n#]+?)["']?\s*(#.*)?$/m;

/**
 * Names of the agents the target repo defines in `.claude/agents`. They load
 * with settingSources: ["project"], and the team may delegate to them; the
 * built-in agents stay off limits.
 */
export function projectAgentNames(cwd: string): string[] {
  const dir = join(cwd, ".claude", "agents");
  let entries;
  try {
    entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => {
      const text = readFileSync(join(entry.parentPath, entry.name), "utf8");
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
      return (
        (frontmatter && NAME.exec(frontmatter)?.[1]?.trim()) ||
        basename(entry.name, ".md")
      );
    });
}
