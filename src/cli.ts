import { readFileSync, statSync } from "node:fs";

export interface Cli {
  task: string;
  cwd: string;
  autoApprove: boolean;
  verbose: boolean;
  /** Exit non-zero when the ledger records calls to check, even if the run succeeded. */
  strict: boolean;
  allow: string[];
  resume?: string | undefined;
  maxTurns?: number | undefined;
  maxBudgetUsd?: number | undefined;
  model?: string | undefined;
}

export function usage(): string {
  return `software-dev-team — an autonomous software development team

  pnpm start "<task>"                  delegate a task to the team
  pnpm start --file ./task.md          read the task from a file
  pnpm start --resume <id> "<answer>"  continue a run, e.g. to answer its question
  pnpm start --roles [--cwd <path>]    list the specialists, checking the
                                       project's prompt customizations, and exit

Options
  --cwd <path>        project the team works in (default: current directory)
  --file <path>       read the task from a file instead of the command line
  -y, --yes           run unattended: file edits inside --cwd are approved, Bash
                      not allowed by --allow is refused, and destructive commands
                      stay blocked either way
  --allow <rule>      let a tool run without approval, e.g. "Bash(pnpm test:*)";
                      repeatable. A rule must name what it allows: bare Bash,
                      Write, Edit, MultiEdit or NotebookEdit, or a wildcard-only
                      specifier such as Bash(*), is rejected.
  --resume <id>       continue the session printed at the end of an earlier run,
                      with the same --cwd
  --verbose           show tool results, not just tool calls
  --strict            exit 3 when the ledger records failed, blocked, refused,
                      background or unfinished calls (a warning is always printed)
  --max-turns <n>     cap the manager's agentic turns (default 60; each
                      specialist has its own cap)
  --max-budget <usd>  stop the run once its estimated cost, specialists
                      included, passes this amount
  --model <name>      override the orchestrator model (e.g. opus, sonnet)
  -h, --help          show this help

A project customizes the team's prompts with files in <cwd>/.claude/dev-team/,
where <name> is a role, "orchestrator" (the manager) or "team" (conventions
every specialist shares):
  <name>.md            appended to the prompt
  <name>.<section>.md  replaces one <section> of it, e.g. qa-tester.output_format.md
  <name>.replace.md    replaces the whole prompt
--roles --cwd <path> checks them. A replacement of the manager's prompt, or of
its <team> section, must keep {{roster}}.

The team reads and writes real files in --cwd. Point it at a project directory,
not at this one, unless you mean for it to edit itself.`;
}

export function parseArgs(
  argv: string[],
): Cli | { help: true } | { roles: true; cwd: string } {
  const positional: string[] = [];
  const allow: string[] = [];
  let cwd = process.cwd();
  let autoApprove = false;
  let verbose = false;
  let strict = false;
  let maxTurns: number | undefined;
  let maxBudgetUsd: number | undefined;
  let model: string | undefined;
  let file: string | undefined;
  let resume: string | undefined;
  let roles = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case "-h":
      case "--help":
        return { help: true };
      case "--roles":
        roles = true;
        break;
      case "--yes":
      case "-y":
        autoApprove = true;
        break;
      case "--verbose":
        verbose = true;
        break;
      case "--strict":
        strict = true;
        break;
      case "--cwd":
        cwd = expect(argv, ++i, "--cwd");
        break;
      case "--file":
        file = expect(argv, ++i, "--file");
        break;
      case "--model":
        model = expect(argv, ++i, "--model");
        break;
      case "--allow":
        allow.push(expect(argv, ++i, "--allow"));
        break;
      case "--resume":
        resume = expect(argv, ++i, "--resume");
        break;
      case "--max-turns": {
        const raw = expect(argv, ++i, "--max-turns");
        maxTurns = Number(raw);
        if (!/^\d+$/.test(raw) || maxTurns <= 0) {
          throw new Error(
            `--max-turns expects a positive integer, got "${raw}"`,
          );
        }
        break;
      }
      case "--max-budget": {
        const raw = expect(argv, ++i, "--max-budget");
        maxBudgetUsd = Number(raw);
        if (!/^\d+(\.\d+)?$/.test(raw) || maxBudgetUsd <= 0) {
          throw new Error(
            `--max-budget expects a positive dollar amount, got "${raw}"`,
          );
        }
        break;
      }
      default:
        if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
        positional.push(arg);
    }
  }

  if (roles) return { roles: true, cwd };

  if (file !== undefined && positional.length > 0) {
    throw new Error("Give either --file or a task as text, not both.");
  }
  const task = file
    ? readFileSync(file, "utf8").trim()
    : positional.join(" ").trim();
  if (!task) {
    if (file !== undefined) {
      throw new Error(`--file ${file} is empty.`);
    }
    if (resume !== undefined) {
      throw new Error("--resume needs a message to send to the session.");
    }
    return { help: true };
  }

  return {
    task,
    cwd,
    autoApprove,
    verbose,
    strict,
    allow,
    resume,
    maxTurns,
    maxBudgetUsd,
    model,
  };
}

function expect(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value === "" || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

const STAT_ERRORS: Record<string, string> = {
  ENOENT: "it does not exist",
  ENOTDIR: "part of the path is a file",
  EACCES: "permission denied",
  EPERM: "operation not permitted",
  ELOOP: "too many symbolic links, or a symlink loop",
  ENAMETOOLONG: "the path is too long",
};

/** A mistyped --cwd would otherwise look like a project with nothing in it. */
export function checkProjectDir(cwd: string): void {
  let isDirectory: boolean;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
    const why = STAT_ERRORS[code] ?? (error as Error).message;
    throw new Error(`--cwd ${cwd} is not a directory (${code}: ${why}).`);
  }
  if (!isDirectory) throw new Error(`--cwd ${cwd} is not a directory.`);
}
