import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { type Family, globTargets, globToRegExp } from "./globs.js";

/**
 * Files that hold credentials, matched against a whole path. Case-insensitive
 * because the default macOS filesystem is: `.ENV` opens `.env`.
 */
export const SECRET_PATH = [
  /(^|\/)\.env(\.(?!(example|sample|template|dist)~?$)[\w.-]+)?~?$/i,
  /(^|\/)\.envrc$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)$/i,
  /(^|\/)\.(ssh|aws|kube)(\/|$)/i,
  /(^|\/)\.docker\/config\.json$/i,
  /\.(pem|key|p12|pfx|tfvars)$/i,
  /(^|\/)credentials(\.json)?$/i,
  /(^|\/)\.(netrc|pgpass|git-credentials|npmrc)$/i,
  /(^|\/)\.credentials\.json$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)\.gnupg(\/|$)/i,
  /(^|\/)\.config\/(gh|gcloud)(\/|$)/i,
  /\.tfstate(\.backup)?$/i,
  // Any process's environment, however it is reached: /proc/1/task/1/environ,
  // /proc/self/root/proc/self/environ.
  /^\/proc\/(.*\/)?environ$/,
];

/**
 * The same material as SECRET_PATH, found as tokens inside a shell command or a
 * glob. Any mention is refused, not only writes: reading a secret into the
 * transcript is the leak.
 */
export const SECRET_IN_TEXT = [
  /(^|[\s"'=|;&(<>/*:\\{,\x60])\.env(?!\.(example|sample|template|dist)\b)(?=$|[\s"'|;&)<>.*/~,}\x60])/i,
  /(^|[\s"'=|;&(<>/:\\{,\x60])\.envrc\b/i,
  /\bid_(rsa|ed25519|ecdsa|dsa)\b(?!\.pub)/i,
  /\.(ssh|aws|kube)\//i,
  /\.docker\/config\.json\b/i,
  /\.(pem|p12|pfx|tfvars)\b/i,
  /\bcredentials\.json\b/i,
  // As file names only: `obj.key` and the word "credentials" in code are common.
  /(^|[\s"'=/:\\*\x60])[\w.*?-]*\.key(?=$|[\s"'|;&)<>\x60])/i,
  /(^|[\s"'=/:\\\x60])credentials(?=$|[\s"'|;&)<>\x60])/i,
  /\.(netrc|pgpass|git-credentials|npmrc)\b/i,
  /\.credentials\.json\b/i,
  /\.pypirc\b/i,
  /\.gnupg\//i,
  /\.config\/(gh|gcloud)\//i,
  /\.tfstate\b/i,
];

/**
 * Secret files for glob checks (see globs.ts), each with ordinary files a
 * glob for that kind of file usually also matches.
 */
const SECRET_FAMILIES: readonly Family[] = [
  {
    targets: [".env", ".env.local", ".env.production", "config/.env"],
    siblings: [],
  },
  {
    targets: [".envrc", ".npmrc", ".netrc", ".pypirc"],
    siblings: [".eslintrc", ".prettierrc", ".babelrc", ".nvmrc"],
  },
  { targets: [".pgpass"], siblings: [] },
  { targets: [".git-credentials"], siblings: [".gitignore", ".gitattributes"] },
  {
    targets: ["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"],
    siblings: [],
  },
  {
    targets: [".ssh/id_rsa", ".ssh/config", ".ssh/known_hosts"],
    siblings: [],
  },
  { targets: [".aws/credentials", ".aws/config"], siblings: [] },
  { targets: [".kube/config"], siblings: ["src/config"] },
  { targets: [".docker/config.json"], siblings: ["app/config.json"] },
  { targets: [".gnupg/pubring.kbx"], siblings: ["Main.kt"] },
  {
    targets: [".config/gh/hosts.yml", ".config/gcloud/credentials.db"],
    siblings: [".github/workflows/ci.yml", "docker-compose.yml"],
  },
  {
    targets: ["server.pem", "cert.p12", "cert.pfx"],
    siblings: ["app.py", "index.php", "logo.png", "notes.pdf"],
  },
  { targets: ["server.key"], siblings: ["Main.kt", "build.gradle.kts"] },
  { targets: ["credentials"], siblings: [] },
  {
    targets: ["credentials.json"],
    siblings: ["package.json", "tsconfig.json"],
  },
  { targets: [".credentials.json"], siblings: [".eslintrc.json"] },
  {
    targets: ["prod.tfvars", "terraform.tfstate", "terraform.tfstate.backup"],
    siblings: ["main.tf"],
  },
];

/**
 * Paths agents must not write, even inside the project. `.claude/`,
 * `.mcp.json` and CLAUDE.md load as hooks, agents, MCP servers and
 * instructions on the next run (settingSources: ["project"]), so a write
 * there persists past this one.
 */
export const PROTECTED_WRITE = [
  ...SECRET_PATH,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)\.pub$/i,
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)\.claude(\/|$)/i,
  /(^|\/)\.mcp\.json$/i,
  /(^|\/)CLAUDE(\.local)?\.md$/i,
];

/** Protected paths for glob checks on shell words. */
export const PROTECTED_FAMILIES: readonly Family[] = [
  {
    targets: [".git", ".git/hooks", ".git/hooks/pre-commit", ".git/config"],
    siblings: [],
  },
  { targets: [".gitconfig"], siblings: [] },
  {
    targets: [".claude", ".claude/settings.json", ".claude/agents"],
    siblings: [],
  },
  { targets: [".mcp.json"], siblings: ["package.json"] },
  {
    targets: ["CLAUDE.md", "CLAUDE.local.md"],
    siblings: ["README.md", "docs.md"],
  },
];

const MAX_SYMLINK_HOPS = 40;

/**
 * Where a path really leads. Symlinks are followed through the nearest
 * existing ancestor, and a dangling link is followed to its target, since a
 * write through it creates the target. Throws on a symlink loop; callers
 * treat a throw as a deny.
 */
export function realTarget(cwd: string, path: string): string {
  let current = resolve(cwd, path);
  const tail: string[] = [];
  for (let hops = 0; hops < MAX_SYMLINK_HOPS; hops += 1) {
    let isLink: boolean;
    try {
      isLink = lstatSync(current).isSymbolicLink();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(current);
      if (parent === current) return join(current, ...tail);
      tail.unshift(basename(current));
      current = parent;
      continue;
    }
    if (isLink && !existsSync(current)) {
      current = resolve(dirname(current), readlinkSync(current));
      continue;
    }
    return join(realpathSync(current), ...tail);
  }
  throw new Error(`Too many symbolic links resolving ${path}`);
}

/**
 * True when a path the agent names, its normalized form, or the file it
 * really reaches through symlinks holds secrets. `/proc//self/environ` and a
 * project symlink to `../.env` are the same file as their plain spelling.
 */
export function isSecretPath(cwd: string, path: string): boolean {
  if (!path) return false;
  const forms = [path, resolve(cwd, path), realTarget(cwd, path)];
  return forms.some((form) => SECRET_PATH.some((p) => p.test(form)));
}

/**
 * True when a Grep glob could select a file that holds secrets. The Grep
 * tool splits its glob on whitespace and then on commas, so each piece is
 * judged on its own as well as whole. A negated piece (`!*.ts`) selects
 * everything else, secrets included.
 */
export function isSecretGlob(glob: string): boolean {
  if (!glob) return false;
  const pieces = glob
    .split(/\s+/)
    .flatMap((piece) => [piece, ...piece.split(",")])
    .filter(Boolean);
  return pieces.some(
    (piece) =>
      // Excluding a directory (`!**/node_modules/**`) is a search with no
      // glob; any other negation selects everything else, secrets included.
      (piece.startsWith("!") && !/^!(\*\*\/)?[\w.-]+\/(\*\*)?$/.test(piece)) ||
      SECRET_IN_TEXT.some((p) => p.test(piece)) ||
      globTargets(piece, SECRET_FAMILIES),
  );
}

const PROC_ENVIRON = ["/proc/self/environ", "/proc/1/environ", "/proc/1/task/1/environ"];

/**
 * True when a shell word with wildcards could expand to a secret file:
 * `.e?v`, `~/.ss?/id_*`, `/proc/self/env*`. Checked from every segment
 * boundary, so a leading `~/`, `./` or directory does not hide it.
 */
export function isSecretWord(word: string): boolean {
  const re = globToRegExp(word);
  if (re === null) return false;
  if (word.startsWith("/proc/") && PROC_ENVIRON.some((p) => re.test(p))) {
    return true;
  }
  const parts = word.split("/");
  return parts.some((_, i) => {
    const suffix = parts.slice(i).join("/");
    return suffix !== "" && globTargets(suffix, SECRET_FAMILIES);
  });
}

function isInside(root: string, real: string): boolean {
  return real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** True when `path`, through any symlinks, lands inside one of the roots. */
export function resolvesInside(
  cwd: string,
  roots: readonly string[],
  path: string,
): boolean {
  const real = realTarget(cwd, path || ".");
  return roots.some((root) => isInside(root, real));
}

/** Why a write tool may not write `path`, or null. */
export function writeDenyReason(cwd: string, path: string): string | null {
  const real = realTarget(cwd, path);
  const inside = real === cwd || real.startsWith(cwd + sep);
  if (!inside) {
    return `Writing to ${path} is not permitted: it resolves outside the project directory.`;
  }
  const projectPath = relative(cwd, real);
  if (PROTECTED_WRITE.some((p) => p.test(path) || p.test(projectPath))) {
    return `Writing to ${path} is not permitted (secrets, git internals or agent configuration).`;
  }
  return null;
}
