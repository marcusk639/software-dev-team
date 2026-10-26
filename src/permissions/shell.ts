import { existsSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import {
  expandLongOptions,
  gitCloneConfigRuns,
  gitConfigWrites,
  gitGlobalOptionReason,
  normalizeGit,
} from "./git.js";
import { globTargets, hasDotLedWildcard } from "./globs.js";
import {
  isSecretPath,
  isSecretWord,
  PROTECTED_FAMILIES,
  SECRET_IN_TEXT,
} from "./paths.js";

/**
 * The Bash layer of the safety policy. It is best-effort pattern matching, not
 * a sandbox: interpreter one-liners and scripts can do anything these
 * patterns name. Under --yes, the CLI itself refuses most Bash that the run
 * has not allow-listed (see allowlist.ts).
 */

/**
 * Wrappers that run the command after them: `sudo env`, `nice -n 5 env`,
 * `bash -c env`, `! env`. Their options and numeric arguments are skipped.
 */
const WRAPPER = String.raw`(?:sudo|doas|time|command|builtin|exec|nohup|nice|eval|stdbuf|xargs|watch|timeout|then|do|else|!|(?:ba|z|da|k|fi)?sh\s+-c)`;
/**
 * A command position: the start, after a shell separator or keyword, or after
 * a wrapper. `cd env` and `docker ps` are arguments, not commands.
 */
const AT = String.raw`(?:^|[;&|(){\x60\n]\s*|(?<![\w./-])${WRAPPER}(?:\s+(?:-\S+|\d[\w.]*))*\s+)`;
/** Leading `NAME=value` assignments, which still leave the command in place. */
const ASSIGNMENTS = String.raw`(?:\w+=\S*\s+)*`;
const ENDS = String.raw`[ \t]*($|[|;&<>)}\x60\n])`;

/**
 * Commands that are never allowed, in any permission mode. Matched against
 * several spellings of the Bash string (see spellings()) so a compound command
 * or a quoting trick cannot smuggle one past the check. `[^|;&\n]*` keeps a
 * match inside one command of a pipeline or list.
 */
const HARD_DENY: Array<{
  pattern: RegExp;
  why: string;
  /** Match only the spellings with git's global options dropped. */
  normalizedOnly?: boolean;
}> = [
  {
    // rm as its own word, however it is reached (after a wrapper, inside
    // bash -c, path-qualified). A subcommand of git, docker and the like is
    // a different tool: `git rm -r --cached` only untracks files. Only a
    // space or tab joins the two: after a newline, rm is its own command.
    pattern:
      /(?<!\b(?:git|docker|podman|kubectl|helm)[ \t]+)(?:^|(?<=[\s;&|({'"`]))(?:\S*\/)?\\?rm\b[^|;&\n]*\s(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?=\s|$|['"])/,
    why: "recursive delete",
    // `git -C . rm -r --cached` is git's rm once -C is dropped.
    normalizedOnly: true,
  },
  {
    // `pnpm rm <pkg>` removes a dependency; with a force flag or a path it
    // is aimed at the filesystem instead.
    pattern:
      /\b(?:npm|pnpm|yarn)\s+rm\b[^|;&\n]*\s(?:-[a-zA-Z]*[rRf][a-zA-Z]*|--recursive|--force|[/~]\S*)(?=\s|$)/,
    why: "recursive delete",
  },
  {
    pattern:
      /\bfind\b[^|;&\n]*\s-(delete\b|(?:exec|ok)(?:dir)?\s+(?:(?:sudo|doas|busybox|env|command|nice)\s+(?:-\S+\s+)*)*(?:\S*\/)?(?:rm|shred|unlink)\b)/,
    why: "bulk delete through find",
  },
  {
    pattern:
      /\bgit\s+push\b[^|;&\n]*\s(--force(-with-lease|-if-includes)?|--mirror|--delete|--prune|-[a-zA-Z]*[fd][a-zA-Z]*)(?=\s|=|$)/,
    why: "force push or remote branch deletion",
  },
  {
    pattern: /\bgit\s+push\b[^|;&\n]*\s[+:]\S/,
    why: "force push or remote branch deletion",
  },
  {
    pattern: /\bgit\s+reset\b[^|;&\n]*\s--hard(?=\s|$)/,
    why: "discards uncommitted work",
  },
  {
    pattern:
      /\bgit\s+checkout\b[^|;&\n]*\s(--|\.|--force|-[a-zA-Z]*[fB][a-zA-Z]*)(?=\s|$)/,
    why: "discards uncommitted work",
  },
  {
    pattern:
      /\bgit\s+switch\b[^|;&\n]*\s(--force|--discard-changes|-[a-zA-Z]*[fC][a-zA-Z]*)(?=\s|$)/,
    why: "discards uncommitted work",
  },
  {
    pattern: /\bgit\s+restore\b(?![^|;&\n]*--staged)/,
    why: "discards uncommitted work",
  },
  {
    pattern: /\bgit\s+restore\b[^|;&\n]*(--worktree|\s-W\b)/,
    why: "discards uncommitted work",
  },
  {
    pattern: /\bgit\s+clean\b[^|;&\n]*\s(-[a-zA-Z]*f[a-zA-Z]*|--force)(?=\s|$)/,
    why: "deletes untracked files",
  },
  {
    pattern: /\bgit\s+branch\b[^|;&\n]*\s-[a-zA-Z]*D[a-zA-Z]*(?=\s|$)/,
    why: "force-deletes a branch",
  },
  {
    // -d with -f in any order or spelling: `-d -f`, `-df`, `--delete --force`.
    pattern:
      /\bgit\s+branch\b(?=[^|;&\n]*\s(?:-[a-zA-Z]*d[a-zA-Z]*|--delete)(?=\s|$))(?=[^|;&\n]*\s(?:-[a-zA-Z]*f[a-zA-Z]*|--force)(?=\s|$))/,
    why: "force-deletes a branch",
  },
  { pattern: /\bgit\s+stash\s+(drop|clear)\b/, why: "deletes stashed work" },
  {
    // `-M`, `-C`, `-f`/`--force` move or overwrite an existing branch.
    pattern:
      /\bgit\s+branch\b[^|;&\n]*\s(?:-[a-zA-Z]*[MCf][a-zA-Z]*|--force)(?=\s|$)/,
    why: "rewrites a branch",
  },
  {
    pattern:
      /\bgit\s+(?:update-ref\b|reflog\s+(?:expire|delete)\b|prune\b|gc\b[^|;&\n]*--prune(?:=|\s+)(?:now|all)\b)/,
    why: "rewrites refs or drops history",
  },
  {
    pattern:
      /\bgit\s+worktree\s+remove\b[^|;&\n]*\s(?:-[a-zA-Z]*f[a-zA-Z]*|--force)(?=\s|$)/,
    why: "discards uncommitted work",
  },
  {
    // read-tree -u writes the index back over the working tree; --reset
    // drops unmerged entries and, with -u, local changes.
    pattern:
      /\bgit\s+read-tree\b[^|;&\n]*\s(?:-[a-zA-Z]*u[a-zA-Z]*|--reset)(?=\s|$)/,
    why: "discards uncommitted work",
  },
  {
    // rsync --delete* removes files the source lacks; --remove-source-files
    // deletes the source as it copies.
    pattern:
      /\brsync\b[^|;&\n]*\s--(?:del\b|delete(?:-[a-z]+)?\b|remove-source-files\b)/,
    why: "recursive delete",
  },
  {
    pattern:
      /\bgh\s+(?:repo\s+delete\b|api\b[^|;&\n]*\s(?:-X\s*|--method(?:=|\s+))['"]?DELETE\b)/i,
    why: "deletes a GitHub repository or resource",
  },
  {
    // Forcing git rm deletes files with uncommitted changes.
    pattern: /\bgit\s+rm\b[^|;&\n]*\s(-[a-zA-Z]*f[a-zA-Z]*|--force)(?=\s|$)/,
    why: "deletes files with uncommitted changes",
  },
  {
    // `git rm -r --cached` only untracks; without --cached it deletes.
    pattern:
      /\bgit\s+rm\b(?![^|;&\n]*--cached)[^|;&\n]*\s(?:-[a-zA-Z]*r[a-zA-Z]*|--recursive)(?=\s|$)/,
    why: "recursive delete",
  },
  {
    pattern: /\bxargs\b[^|;&\n]*?\s(?:\S*\/)?(?:rm|rmdir|shred|unlink)(?=\s|$)/,
    why: "recursive delete",
  },
  {
    // ANSI-C quoting, $IFS and a variable in command position spell a
    // command the patterns cannot read: `$'\x72m'`, `rm${IFS}-rf`, `$A -rf`.
    pattern: new RegExp(
      String.raw`\$'|\$\{?IFS\b|${AT}${ASSIGNMENTS}\$\{?[A-Za-z_@*0-9]`,
    ),
    why: "hides the command it runs",
  },
  {
    // Configuration and programs supplied through the environment.
    pattern:
      // An editor of `true` or `:` only accepts the message or todo list.
      /(?<![\w$])GIT_(?:CONFIG\w*|DIR|EXEC_PATH|SSH(?:_COMMAND)?|EXTERNAL_DIFF|ASKPASS|PROXY_COMMAND|TEMPLATE_DIR|(?:SEQUENCE_)?EDITOR(?!=['"]?(?:true|:)['"]?(?:\s|$)))=/,
    why: "changes what git runs",
  },
  {
    // Only when sent to a database client: writing a migration file that
    // contains DROP TABLE, or grepping for it, is ordinary work.
    pattern:
      /\b(psql|mysql|mariadb|sqlite3|pgcli|duckdb)\b[^|;&]*\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i,
    why: "destructive schema change",
  },
  {
    pattern:
      /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b[^;&]*\|\s*(psql|mysql|mariadb|sqlite3|pgcli|duckdb)\b/i,
    why: "destructive schema change",
  },
  { pattern: /\bprisma\s+migrate\s+reset\b/, why: "resets the database" },
  {
    pattern: /\bprisma\s+db\s+push\b[^|;&\n]*--accept-data-loss/,
    why: "accepts data loss",
  },
  { pattern: /\bdropdb\b/, why: "drops a database" },
  {
    pattern: /\b(curl|wget)\b[^|;&\n]*\|\s*(sudo\s+)?(\S*\/)?(ba|z|da|k)?sh\b/,
    why: "pipes a remote script to a shell",
  },
  {
    pattern: /[$<]\(\s*(curl|wget)\b/,
    why: "runs a remote script",
  },
  {
    pattern: /\b(curl|wget)\b.*&&\s*(sudo\s+)?(ba|z)?sh\s+\S/,
    why: "downloads and runs a script",
  },
  {
    pattern: /\b(npm|pnpm|yarn)\b[^|;&\n]*\spublish\b/,
    why: "publishes to a registry",
  },
  { pattern: />\s*\/dev\/[sh]d[a-z]/, why: "writes to a raw device" },
];

/** Quotes and backslashes removed: `r''m`, `"rm"` and `\rm` all run rm. */
function dequote(command: string): string {
  return command.replace(/['"\\]/g, "");
}

/** The forms of a command the rules are matched against. */
function spellings(raw: string): string[] {
  const forms = new Set<string>();
  for (const base of [raw, dequote(raw)]) {
    const expanded = expandLongOptions(base);
    forms.add(base);
    forms.add(expanded);
    forms.add(normalizeGit(expanded));
  }
  return [...forms];
}

/**
 * Commands whose options carry a message, with those options. Their text is
 * prose: "explain why git reset --hard is blocked" runs nothing.
 */
const MESSAGE_COMMANDS: ReadonlyArray<{ head: RegExp; flags: string }> = [
  {
    head: /(?:^|[\s(])git(?:\s+-\S+(?:\s+[^-\s]\S*)?)*?\s+(?:commit|tag|notes\s+(?:add|append)|merge|stash(?:\s+(?:push|save))?)\b/,
    flags: String.raw`-[a-zA-Z]*m|--message`,
  },
  {
    head: /(?:^|[\s(])gh\s+(?:pr|issue|release)\s+(?:create|edit|comment|review)\b/,
    flags: String.raw`--title|--body|--notes|-[tbn]`,
  },
];

/**
 * A message value whose text cannot run anything: single-quoted, double-quoted
 * with no `$` or backtick, or the `"$(cat <<'EOF' … EOF)"` form whose quoted
 * delimiter turns expansion off.
 */
const MESSAGE_VALUE = String.raw`(?:'[^']*'|"(?:[^"\\$\x60]|\\.)*"|"\$\(\s*cat\s+<<-?\s*(['"])(\w+)\2[ \t]*\n[\s\S]*?\n[ \t]*\3[ \t]*\n?\s*\)")`;

/** Quoted text blanked to the same length, so a `;` inside a message is not a separator. */
function maskQuotes(command: string): string {
  return command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (q) => "x".repeat(q.length));
}

/**
 * Commit messages, PR titles and bodies, tag and note messages often name a
 * blocked command or a protected file ("add .env to .gitignore", "explain why
 * git reset --hard is blocked"). Their text is dropped before any check, but
 * only on a command that takes a message (MESSAGE_COMMANDS): `bash -cm '…'`
 * runs its argument. Text that could run a substitution is kept, so
 * `-m "$(cat .env)"` and an unquoted heredoc are still seen.
 */
function withoutMessages(command: string): string {
  const masked = maskQuotes(command);
  let out = command;
  for (const { head, flags } of MESSAGE_COMMANDS) {
    const option = new RegExp(
      String.raw`(\s(?:${flags})(?:=|\s+))${MESSAGE_VALUE}`,
      "g",
    );
    out = out.replace(option, (match, prefix: string, ...rest) => {
      const offset = rest[rest.length - 2] as number;
      const before = masked.slice(0, offset);
      const segment = before.slice(
        Math.max(...[";", "&", "|", "\n"].map((sep) => before.lastIndexOf(sep))) + 1,
      );
      return head.test(segment) ? `${prefix}''` : match;
    });
  }
  return out;
}

/** `echo .env >> .gitignore` names a secret file without reading it. */
const IGNORE_FILE_APPEND =
  /^\s*(echo|printf)\s[^|;&<>`$]*>>?\s*(\S*\/)?\.(git|docker)ignore\s*$/i;


/**
 * Ways to print the process environment, which holds the API key. Scripts and
 * test suites can still read it; masking it needs the SDK sandbox's credential
 * settings.
 */
const ENV_DUMP = [
  // env with nothing to run prints the environment: `env`, `/usr/bin/env`,
  // `env -i`, `env -u X`, `env FOO=1`.
  new RegExp(
    String.raw`${AT}${ASSIGNMENTS}(?:\S*\/)?env(?:\s+(?:-u\s*\S+|-\S*|\w+=\S*))*${ENDS}`,
  ),
  new RegExp(String.raw`${AT}${ASSIGNMENTS}export(\s+-p)?${ENDS}`),
  new RegExp(
    String.raw`${AT}(declare|typeset)\s+-[a-zA-Z]*[px][a-zA-Z]*${ENDS}`,
  ),
  new RegExp(String.raw`${AT}${ASSIGNMENTS}set${ENDS}`),
  /\bcompgen\s+-\w*[ev]/,
  new RegExp(String.raw`${AT}ps\s+-?[a-zA-Z]*[eE][a-zA-Z]*(?=\s|$)`),
  /\bprintenv\b/,
  /\bscript\b[^|;&\n]*\s(?:env|printenv|set|export|declare)(?=\s|$)/,
  /\$\{?[A-Za-z_]*(API_?KEY|TOKEN|SECRET|PASSW(OR)?D|PRIVATE_KEY|CREDENTIAL)/i,
  /\/proc\/\S*\/environ\b/,
  // Indirect expansion reads a variable by a computed name: `${!n}`, and
  // `${!A*}` lists names to read that way.
  /\$\{!/,
  // Only inside an interpreter one-liner: code that mentions process.env is
  // ordinary, and grepping or editing it must keep working.
  /\b(node|nodejs|python3?|ruby|perl|deno|bun|php)\b[^|&\n]*\s(-e|-c|-p|-E|-r|--eval|--print)\b[^\n]*(\benv\b|environ|getenv|\bENV\b|%ENV|\$_ENV)/,
  /\bsecurity\s+(find|dump)-\w+/,
];

/** Mentions of git internals or agent configuration inside a shell command. */
const CONFIG_MENTION = [
  /(^|[^\w.-])\.(claude|git)(?=$|[/\s"'|;&)<>,}])/i,
  /\.mcp\.json\b/i,
  /\bid_(rsa|ed25519|ecdsa|dsa)\.pub\b/i,
  /\.gitconfig\b/i,
  /\.config\/git\//i,
  /\$\{?XDG_CONFIG_HOME\}?\/git\//i,
  /(^|[^\w.-])CLAUDE(\.local)?\.md\b/i,
];

/**
 * A word with a wildcard that could expand to a protected path: `.gi?/hooks`,
 * `.cl?ude`, `.mcp.js?n`, `CLAUD?.md`. Any wildcard inside a hidden segment
 * counts, since that is where git and agent configuration live.
 */
function mentionsProtectedGlob(command: string): boolean {
  return command
    .split(SHELL_WORD_SPLIT)
    .map(expandVariables)
    .filter((word) => /[?*[{]/.test(word))
    .some((word) => {
      if (hasDotLedWildcard(word)) return true;
      // `a/b/.gi?/hooks` is checked from every segment boundary.
      const parts = word.replace(/^\.\//, "").split("/");
      return parts.some((_, i) =>
        globTargets(parts.slice(i).join("/"), PROTECTED_FAMILIES),
      );
    });
}

const READ_ONLY_COMMANDS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "wc",
  "stat",
  "file",
  "du",
  "tree",
  "pwd",
  "echo",
  "test",
  "[",
]);
const READ_ONLY_GIT = new Set([
  "status",
  "log",
  "diff",
  "show",
  "ls-files",
  "rev-parse",
  "blame",
  "check-ignore",
  "grep",
]);

/**
 * True when every command in the pipeline only reads. Writes can come from
 * dozens of verbs (touch, mkdir, tar, curl -o, perl -i…), so commands that
 * mention protected paths are judged by what they are allowed to be, not by
 * a list of what they must not be.
 */
function isReadOnly(command: string): boolean {
  // Nested commands run whatever they contain, whatever the outer verb is.
  if (/\$\(|`|[<>]\(/.test(command)) return false;
  // Any redirect writes, except the forms that only discard or merge output.
  const withoutBenign = command.replace(/\d?>&\d|&?\d?>\s*\/dev\/null/g, "");
  if (/>/.test(withoutBenign)) return false;
  return withoutBenign
    .split(/&&|\|\||[|;&\n]/)
    .map((segment) => segment.trim().replace(/^(\w+=\S*\s+)+/, ""))
    .filter(Boolean)
    .every((segment) => {
      // Flags that make a reading command write a file or run a program.
      if (
        /(^|\s)(--output\b|--pre\b|--ext-diff\b|--open-files-in-pager\b|-O\S*|-fls\b|-fprint)/.test(
          segment,
        ) ||
        /^tree\b.*\s-o\b/.test(segment)
      ) {
        return false;
      }
      // Only `-C dir` and `--no-pager` are dropped here: they change where
      // and how git reads. Any other global option (`-c key=value`) stays in
      // the subcommand position, which is never on READ_ONLY_GIT.
      const [head = "", sub = ""] = segment
        .replace(/^\\/, "")
        .replace(/^git\s+((-C\s+\S+|--no-pager)\s+)+/, "git ")
        .split(/\s+/);
      if (head === "git") return READ_ONLY_GIT.has(sub);
      if (head === "find")
        return !/\s-(delete|exec|execdir|ok|fprint)/.test(segment);
      return READ_ONLY_COMMANDS.has(head);
    });
}

/** Commands whose job is to print a credential, or to search hidden files. */
const SECRET_COMMANDS = [
  /\bgh\s+auth\s+(?:token\b|status\b[^|;&\n]*\s(?:-t|--show-token)\b)/,
  /\bgit\s+credential(?:-[\w-]+)?\s+(?:fill|get)\b/,
  // ripgrep skips hidden and ignored files unless told otherwise; .env is both.
  // Allowed when the command excludes .env* itself.
  /\brg\b(?=[^|;&\n]*\s(-[a-zA-Z]*u[a-zA-Z]*|--no-ignore\S*|--hidden|-\.)(?=\s|$))(?![^|;&\n]*(-g|--glob)[\s=]*["']?!\.env)/,
];

/**
 * A file-reading command whose argument is a command substitution reads a
 * file the patterns never see: `cat $(echo .e""nv)`, `grep KEY $(ls -a)`.
 */
const READS_SUBSTITUTION =
  /(?:^|[;&|(\n]\s*|\s)(?:cat|head|tail|less|more|bat|nl|tac|grep|egrep|fgrep|rg|ag|sed|awk|cut|sort|uniq|xxd|od|hexdump|strings|base64|cp|scp)\b[^|;&\n]*[\s=<](?:\$\(|\x60)/;

const SHELL_WORD_SPLIT = /[\s|;&()<>=\x60]+/;

const VARIABLE = /\$(?:\{[A-Za-z_][\w]*\}|[A-Za-z_]\w*|[0-9@*#?])/g;

/**
 * A word with its variables replaced by `*`, then dequoted: `"$f"v` becomes
 * `*v`, `CLA"$u"DE.md` becomes `CLA*DE.md`, so the glob checks see every
 * name the word could spell. A word that is only a variable (`"$FILE"`) is
 * returned as it was: it names nothing the checks can judge.
 */
function expandVariables(word: string): string {
  if (!word.includes("$")) return word;
  const expanded = dequote(word.replace(VARIABLE, "*"));
  return /^\**$/.test(expanded) ? word : expanded;
}

/**
 * True when a word of the command reaches a secret: a wildcard that could
 * expand to one (`.e?v`, `~/.ss*\/i*`, `/proc/self/env*`), or a path inside
 * the project that resolves through a symlink to one (`config/local` ->
 * `../.env`). Read-only commands are checked too: reading is the leak.
 */
function wordsReachSecret(command: string, cwd: string | undefined): boolean {
  return command
    .split(/&&|\|\||[|;&\n]/)
    .some((segment) => {
      const words = segment.split(SHELL_WORD_SPLIT).filter(Boolean);
      // These print names, not contents: `ls -d .*` lists, it does not read.
      if (NAME_ONLY.has(words[0] ?? "")) return false;
      return words.some((spelled) => {
        const word = expandVariables(spelled);
        if (/[?*[{]/.test(word)) return isSecretWord(word);
        if (cwd === undefined || word.startsWith("-") || word.includes("$")) {
          return false;
        }
        try {
          lstatSync(resolve(cwd, word));
        } catch (error) {
          // Not a path. Anything else (EACCES) means the word cannot be
          // checked, and the caller turns the throw into a deny.
          if (NOT_A_PATH.has((error as NodeJS.ErrnoException).code ?? "")) {
            return false;
          }
          throw error;
        }
        return isSecretPath(cwd, word);
      });
    });
}

const NAME_ONLY = new Set(["ls", "echo", "printf", "tree", "du", "stat"]);

/** lstat errors that mean a word names no file, rather than one that cannot be checked. */
const NOT_A_PATH = new Set(["ENOENT", "ENOTDIR", "ENAMETOOLONG", "EINVAL"]);

/**
 * A recursive grep ignores .gitignore, so one rooted at the project (or with
 * no path, which means the current directory), a parent, or an absolute path
 * reaches .env. One confined to subdirectories such as src does not, and
 * neither does one that excludes .env* itself.
 */
function recursiveGrepReachesSecrets(command: string): boolean {
  return command
    .split(/&&|\|\||[|;&\n]/)
    .map((segment) => segment.trim().split(/\s+/))
    .some(([head = "", ...args]) => {
      if (!/^[ef]?grep$/.test(head)) return false;
      const recursive = args.some((a) =>
        /^(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|--dereference-recursive)$/.test(
          a,
        ),
      );
      if (!recursive || args.some((a) => /^--exclude=["']?\.env/.test(a))) {
        return false;
      }
      // The first operand is the pattern, whether given bare or after -e.
      const paths = args.filter((a) => !a.startsWith("-")).slice(1);
      return (
        paths.length === 0 ||
        paths.some((p) => /^(\.{1,2}\/?|\/.*|~.*)$/.test(p) || /\.env/.test(p))
      );
    });
}

/** Exclusion arguments name .env only to keep it out of a search. */
function withoutExclusions(command: string): string {
  return command.replace(
    /\s(--exclude(-dir)?=\S+|(-g|--glob)[\s=]*["']?!\S+)/g,
    " ",
  );
}

/**
 * `git checkout` with a path restores files, discarding their changes, while
 * `git checkout <branch>` only switches. A path is a second non-option
 * argument, or a single one that exists in the project.
 */
function checkoutDiscards(command: string, cwd: string | undefined): boolean {
  return command
    .split(/&&|\|\||[|;&\n]/)
    .map((segment) => segment.trim().split(/\s+/))
    .some(([git, sub, ...args]) => {
      if (git !== "git" || sub !== "checkout") return false;
      if (args.some((a) => /^(-b|-B|--orphan|-t|--track)$/.test(a)))
        return false;
      const operands = args.filter((a) => !a.startsWith("-"));
      return (
        operands.length >= 2 ||
        (operands.length === 1 &&
          cwd !== undefined &&
          existsSync(resolve(cwd, operands[0]!)))
      );
    });
}

/**
 * Why a Bash command is refused, or null. `cwd` lets words that name files
 * be resolved through symlinks; without it (the allowlist's use) only the
 * text is judged.
 */
export function bashDenyReason(command: string, cwd?: string): string | null {
  // bash deletes a backslash-newline, joining the words on either side.
  const raw = command.replace(/\\\r?\n/g, "");
  // Message text is judged as text, never as a command or a mention.
  const mentions = withoutExclusions(withoutMessages(raw));
  const forms = spellings(withoutMessages(raw));
  const normalized = forms.map(normalizeGit);
  const why =
    HARD_DENY.find((rule) =>
      (rule.normalizedOnly ? normalized : forms).some((form) =>
        rule.pattern.test(form),
      ),
    )?.why ??
    (normalized.some((form) => checkoutDiscards(form, cwd))
      ? "git checkout with a path discards uncommitted changes"
      : undefined) ??
    forms.map(gitGlobalOptionReason).find(Boolean) ??
    (forms.some(gitConfigWrites) || forms.some(gitCloneConfigRuns)
      ? "changes what git runs"
      : undefined);
  if (why) {
    return `Blocked by the team's safety policy (${why}). If this is genuinely required, ask the human operator to run it directly.`;
  }
  const mentionForms = [mentions, dequote(mentions)];
  if (
    (!IGNORE_FILE_APPEND.test(mentions) &&
      mentionForms.some((m) => SECRET_IN_TEXT.some((p) => p.test(m)))) ||
    forms.some((form) => ENV_DUMP.some((p) => p.test(form))) ||
    forms.some((form) => SECRET_COMMANDS.some((p) => p.test(form))) ||
    forms.some(recursiveGrepReachesSecrets) ||
    mentionForms.some((m) => READS_SUBSTITUTION.test(m)) ||
    mentionForms.some((m) => wordsReachSecret(m, cwd))
  ) {
    return "That command reads secrets or the process environment. Ask the human operator for what you need instead.";
  }
  // A protected path can also be written from the shell, which never reaches
  // the Write tool, so any command touching one must be read-only.
  if (
    mentionForms.some(
      (m) => CONFIG_MENTION.some((p) => p.test(m)) || mentionsProtectedGlob(m),
    ) &&
    !isReadOnly(mentions)
  ) {
    return "That command may write to git internals or agent configuration. Only read-only commands may touch those paths; ask the human operator to do it directly.";
  }
  return null;
}
