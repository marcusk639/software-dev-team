import { execFileSync } from "node:child_process";

/**
 * The paths `git status` reports in `cwd` (modified, staged, untracked, and
 * both sides of a rename), relative to the repository root and sorted, or
 * null when `cwd` is not in a git checkout or git cannot run. Read by the
 * harness after a run, never by an agent, so an outer orchestrator knows
 * exactly what to review and commit. `--no-optional-locks` keeps it from
 * taking the index lock a concurrent git process may hold.
 */
export function changedFiles(cwd: string): string[] | null {
  let out: string;
  try {
    out = execFileSync(
      "git",
      [
        "--no-optional-locks",
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return null;
  }
  const fields = out.split("\0");
  const paths = new Set<string>();
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i]!;
    if (field.length < 4) continue;
    paths.add(field.slice(3));
    // A rename or copy is followed by its source path as its own field.
    if (field[0] === "R" || field[0] === "C") {
      const source = fields[++i];
      if (source) paths.add(source);
    }
  }
  return [...paths].sort();
}
