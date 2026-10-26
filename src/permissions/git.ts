/**
 * git-specific parsing for the Bash layer: global options, abbreviated long
 * options, `-c` keys and `git config` invocations.
 */

/** git global options that take their value as the next word. */
const GIT_OPTION_WITH_VALUE = [
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
  "--super-prefix",
];
const GIT_GLOBAL_OPTIONS = String.raw`(?:(?:${GIT_OPTION_WITH_VALUE.join("|")})(?:[ \t]+|=)\S+|-\S+)`;

/**
 * `git -C dir push`, `git -P push` and `git --literal-pathspecs push` must
 * match the same rules as `git push`, so every global option between `git`
 * and its subcommand is dropped. Only spaces and tabs separate them: a
 * newline ends the git command, so `git -C\nrm -rf x` keeps its rm.
 */
export function normalizeGit(command: string): string {
  return command.replace(
    new RegExp(
      String.raw`(?<![\w.-])git(?:[ \t]+${GIT_GLOBAL_OPTIONS})+(?=[ \t])`,
      "g",
    ),
    "git",
  );
}

/**
 * Long options that the rules name. git (and GNU rm) accept any unambiguous
 * prefix, so `git reset --har` is `git reset --hard`.
 */
const NAMED_LONG_OPTIONS = [
  "--force",
  "--force-with-lease",
  "--force-if-includes",
  "--hard",
  "--delete",
  "--mirror",
  "--prune",
  "--discard-changes",
  "--worktree",
  "--recursive",
];

export function expandLongOptions(command: string): string {
  return command.replace(/(?<=\s)--[a-z][a-z-]*(?==|\s|$)/g, (option) =>
    NAMED_LONG_OPTIONS.includes(option)
      ? option
      : (NAMED_LONG_OPTIONS.find((full) => full.startsWith(option)) ?? option),
  );
}

/** `-c` keys that only change how git prints or who it records as author. */
const SAFE_GIT_C_KEY =
  /^(user\.(name|email)|color\.[\w.-]+|advice\.[\w-]+|core\.quotepath|init\.defaultbranch|commit\.gpgsign|tag\.gpgsign|log\.[\w-]+|pull\.rebase|column\.ui)$/i;

/**
 * Global options that hand git a program to run: `-c` with any key outside
 * SAFE_GIT_C_KEY (alias.*, include.path, filter.*, core.sshCommand…),
 * `--config-env`, and `--exec-path=<dir>`.
 */
export function gitGlobalOptionReason(command: string): string | null {
  for (const match of command.matchAll(/(?<![\w.-])git\s+([^|;&\n]*)/g)) {
    const words = (match[1] ?? "").trim().split(/\s+/);
    for (let i = 0; i < words.length; i += 1) {
      const word = words[i] ?? "";
      if (!word.startsWith("-")) break;
      if (/^--config-env\b/.test(word) || /^--exec-path=/.test(word)) {
        return "changes what git runs";
      }
      const name = word.replace(/=.*/, "");
      const takesValue =
        GIT_OPTION_WITH_VALUE.includes(name) && !word.includes("=");
      const value = takesValue ? (words[i + 1] ?? "") : word.slice(2);
      if (name === "-c" || (word.startsWith("-c") && !word.startsWith("--"))) {
        const key = value.replace(/^['"]/, "").replace(/=.*/s, "");
        if (!SAFE_GIT_C_KEY.test(key)) return "changes what git runs";
      }
      if (takesValue) i += 1;
    }
  }
  return null;
}

/**
 * Splits shell text into words the way bash groups them (quotes, backslash
 * escapes), stopping at the end of the simple command: an unquoted `|`, `;`,
 * `&`, newline, or a `#` that starts a word (the rest is a comment).
 */
export function shellWords(text: string): string[] {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      word += end === -1 ? text.slice(i + 1) : text.slice(i + 1, end);
      i = end === -1 ? text.length : end;
      inWord = true;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j += 1) {
        if (text[j] === "\\" && j + 1 < text.length) j += 1;
        word += text[j];
      }
      i = j;
      inWord = true;
    } else if (c === "\\" && i + 1 < text.length) {
      i += 1;
      word += text[i];
      inWord = true;
    } else if (/[|;&\n]/.test(c)) {
      break;
    } else if (/\s/.test(c)) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else if (c === "#" && !inWord) {
      break;
    } else {
      word += c;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  return words;
}

/** Actions that only read, with how many name/pattern arguments they take. */
const CONFIG_READ_ACTIONS: Record<string, readonly [number, number]> = {
  "--get": [1, 1],
  "--get-all": [1, 1],
  "--get-regexp": [1, 1],
  "--get-urlmatch": [2, 2],
  "--list": [0, 0],
  "-l": [0, 0],
  get: [1, 1],
  list: [0, 0],
};
/** Options that take a value and only choose what or how to read. */
const CONFIG_VALUE_OPTIONS = new Set([
  "--file",
  "-f",
  "--blob",
  "--type",
  "--default",
]);
const CONFIG_READ_OPTIONS = new Set([
  "--global",
  "--system",
  "--local",
  "--worktree",
  "--show-origin",
  "--show-scope",
  "--name-only",
  "-z",
  "--null",
  "--bool",
  "--int",
  "--bool-or-int",
  "--path",
  "--expiry-date",
  "--includes",
  "--no-includes",
  "--all",
  "--fixed-value",
]);

/**
 * True when the words after `git config` only read. git decides the mode
 * from an action option anywhere on the line, but `git config k v --get`
 * still writes on git 2.55, so a read needs the action before the key and no
 * value argument. With no action, exactly one argument is a read
 * (`git config user.name`).
 */
function isConfigRead(words: readonly string[]): boolean {
  let action: string | undefined;
  let i = 0;
  const first = words[0];
  if (first === "get" || first === "list") {
    action = first;
    i = 1;
  }
  const positionals: string[] = [];
  for (; i < words.length; i += 1) {
    const word = words[i]!;
    if (word.startsWith("-") && word !== "-") {
      const name = word.replace(/=.*/s, "");
      if (CONFIG_READ_ACTIONS[name] !== undefined) {
        if (action !== undefined || positionals.length > 0) return false;
        action = name;
      } else if (CONFIG_VALUE_OPTIONS.has(name)) {
        if (!word.includes("=")) i += 1;
      } else if (!CONFIG_READ_OPTIONS.has(name)) {
        return false;
      }
      continue;
    }
    positionals.push(word);
  }
  const [min, max] =
    action === undefined ? [1, 1] : CONFIG_READ_ACTIONS[action]!;
  return positionals.length >= min && positionals.length <= max;
}

/** True when the command runs a `git config` that may write. */
export function gitConfigWrites(command: string): boolean {
  for (const match of normalizeGit(command).matchAll(
    /(?<![\w.-])git\s+config(?=\s|$)/g,
  )) {
    const rest = normalizeGit(command).slice(match.index + match[0].length);
    if (!isConfigRead(shellWords(rest))) return true;
  }
  return false;
}

/** Keys that hand git a program or a source of further configuration. */
const DANGEROUS_CONFIG_KEY =
  /^(alias\.|include|filter\.|core\.(hookspath|fsmonitor|sshcommand|gitproxy|pager|editor|askpass)|diff\..*\.(textconv|command)|merge\..*\.driver|credential|protocol\.|uploadpack\.|sequence\.editor|gpg\.|.*proxy|.*command$)/i;

/** True when `git clone` is handed configuration that runs something. */
export function gitCloneConfigRuns(command: string): boolean {
  for (const match of normalizeGit(command).matchAll(
    /(?<![\w.-])git\s+clone(?=\s)/g,
  )) {
    const words = shellWords(
      normalizeGit(command).slice(match.index + match[0].length),
    );
    for (let i = 0; i < words.length; i += 1) {
      const word = words[i]!;
      let value: string | undefined;
      if (word === "-c" || word === "--config") value = words[i + 1];
      else if (word.startsWith("--config=")) value = word.slice(9);
      else if (/^-c./.test(word)) value = word.slice(2);
      if (
        value !== undefined &&
        DANGEROUS_CONFIG_KEY.test(value.replace(/=.*/s, ""))
      ) {
        return true;
      }
    }
  }
  return false;
}
