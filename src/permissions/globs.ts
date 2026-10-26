/**
 * Glob checks for the safety policy. Patterns are matched the way ripgrep
 * (globset) matches them, the loosest of the tools involved: a wildcard can
 * match a leading dot (`?env` matches `.env`), `\x` escapes a character, and
 * a pattern without a slash matches a file name at any depth.
 */

const cache = new Map<string, RegExp | null>();

function escape(c: string): string {
  return c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * Translates a glob to an anchored, case-insensitive RegExp
 * (case-insensitive because the default macOS filesystem is). Returns null
 * for a pattern with no wildcard, which the literal path checks cover.
 */
export function globToRegExp(glob: string): RegExp | null {
  const cached = cache.get(glob);
  if (cached !== undefined) return cached;
  let out = "";
  let wild = false;
  let depth = 0;
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]!;
    if (c === "\\" && i + 1 < glob.length) {
      i += 1;
      out += escape(glob[i]!);
    } else if (c === "*") {
      wild = true;
      if (glob[i + 1] === "*") {
        const atStart =
          i === 0 ||
          glob[i - 1] === "/" ||
          glob[i - 1] === "{" ||
          glob[i - 1] === ",";
        i += 1;
        if (glob[i + 1] === "/" && atStart) {
          i += 1;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      wild = true;
      out += "[^/]";
    } else if (c === "[") {
      const end = glob.indexOf("]", i + 2);
      if (end === -1) {
        out += "\\[";
        continue;
      }
      wild = true;
      let body = glob.slice(i + 1, end);
      const negate = body.startsWith("!") || body.startsWith("^");
      if (negate) body = body.slice(1);
      out += `[${negate ? "^/" : ""}${body.replace(/[\\\]^]/g, "\\$&")}]`;
      i = end;
    } else if (c === "{" && glob.indexOf("}", i) !== -1) {
      wild = true;
      depth += 1;
      out += "(?:";
    } else if (c === "}" && depth > 0) {
      depth -= 1;
      out += ")";
    } else if (c === "," && depth > 0) {
      out += "|";
    } else {
      out += escape(c);
    }
  }
  out += ")".repeat(depth);
  let result: RegExp | null = null;
  if (wild) {
    const anchored = glob.includes("/") ? out : `(?:.*/)?${out}`;
    try {
      result = new RegExp(`^${anchored}$`, "i");
    } catch {
      // A pattern we cannot model is treated as matching everything.
      result = /^/;
    }
  }
  cache.set(glob, result);
  return result;
}

/**
 * Protected files of one kind, with ordinary files that a glob for that kind
 * usually also matches. `**\/.*rc` reaches `.npmrc`, but it reaches
 * `.eslintrc` too: it is a config-file glob, not one aimed at the secret.
 */
export interface Family {
  readonly targets: readonly string[];
  readonly siblings: readonly string[];
}

/** Ordinary project files. A glob matching most of them is a generic search. */
const ORDINARY = [
  "index.ts",
  "src/index.ts",
  "README.md",
  "package.json",
  "main.py",
  "src/App.tsx",
  "Makefile",
  "lib/util.js",
  "styles/site.css",
  "docs/guide.md",
];
const GENERIC_AT = 4;

/**
 * True when the glob singles out a target of one of the families: it matches
 * the target, is not generic, and matches none of that family's siblings.
 */
export function globTargets(
  glob: string,
  families: readonly Family[],
): boolean {
  const re = globToRegExp(glob);
  if (re === null) return false;
  if (ORDINARY.filter((p) => re.test(p)).length >= GENERIC_AT) return false;
  return families.some(
    (family) =>
      family.targets.some((t) => re.test(t)) &&
      !family.siblings.some((s) => re.test(s)),
  );
}

/** True when a segment that starts with a dot holds a wildcard (`.gi?`, `.cl*`). */
export function hasDotLedWildcard(glob: string): boolean {
  return glob
    .split("/")
    .some(
      (segment) =>
        segment.startsWith(".") &&
        segment !== "." &&
        segment !== ".." &&
        /[?*[{]/.test(segment),
    );
}
