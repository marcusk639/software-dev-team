#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createRenderer } from "./render.js";
import { runTeam } from "./orchestrator.js";
import { ROLES, TEAM } from "./team.js";

interface Cli {
  task: string;
  cwd: string;
  autoApprove: boolean;
  verbose: boolean;
  maxTurns?: number | undefined;
  model?: string | undefined;
}

function usage(): string {
  return `software-dev-team — an autonomous software development team

  pnpm start "<task>"                  delegate a task to the team
  pnpm start --file ./task.md          read the task from a file
  pnpm start --roles                   list the specialists and exit

Options
  --cwd <path>        project the team works in (default: current directory)
  --yes               auto-approve tool use (destructive commands stay blocked)
  --verbose           show tool results, not just tool calls
  --max-turns <n>     cap agentic turns
  --model <name>      override the orchestrator model (e.g. opus, sonnet)

The team reads and writes real files in --cwd. Point it at a project directory,
not at this one, unless you mean for it to edit itself.`;
}

function parseArgs(argv: string[]): Cli | { help: true } | { roles: true } {
  const positional: string[] = [];
  let cwd = process.cwd();
  let autoApprove = false;
  let verbose = false;
  let maxTurns: number | undefined;
  let model: string | undefined;
  let file: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case "-h":
      case "--help":
        return { help: true };
      case "--roles":
        return { roles: true };
      case "--yes":
      case "-y":
        autoApprove = true;
        break;
      case "--verbose":
        verbose = true;
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
      case "--max-turns": {
        const raw = expect(argv, ++i, "--max-turns");
        maxTurns = Number.parseInt(raw, 10);
        if (!Number.isFinite(maxTurns) || maxTurns <= 0) {
          throw new Error(
            `--max-turns expects a positive integer, got "${raw}"`,
          );
        }
        break;
      }
      default:
        if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
        positional.push(arg);
    }
  }

  const task = file
    ? readFileSync(file, "utf8").trim()
    : positional.join(" ").trim();
  if (!task) return { help: true };

  return { task, cwd, autoApprove, verbose, maxTurns, model };
}

function expect(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

async function main(): Promise<number> {
  let cli: Cli | { help: true } | { roles: true };
  try {
    cli = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${usage()}`);
    return 2;
  }

  if ("help" in cli) {
    console.log(usage());
    return 0;
  }

  if ("roles" in cli) {
    for (const role of ROLES) {
      console.log(
        `${role}  [${TEAM[role]!.model ?? "default"}]\n  ${TEAM[role]!.description}\n`,
      );
    }
    return 0;
  }

  if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    // Not a hard gate: the SDK also authenticates from the credentials stored by
    // `claude login`, where neither variable is set.
    console.error(
      "\x1b[2mNo ANTHROPIC_API_KEY set; using stored Claude Code credentials.\x1b[0m",
    );
  }

  // Interactive mode blocks on a readline prompt, which never resolves without
  // a TTY; fail fast instead of hanging in CI or a pipe.
  if (!cli.autoApprove && !process.stdin.isTTY) {
    console.error("No TTY available for approval prompts. Re-run with --yes to auto-approve.");
    return 2;
  }

  const summary = await runTeam({
    task: cli.task,
    cwd: cli.cwd,
    autoApprove: cli.autoApprove,
    maxTurns: cli.maxTurns,
    model: cli.model,
    onMessage: createRenderer({ verbose: cli.verbose }),
  });

  if (summary.isError) {
    console.error(`\n${summary.result}`);
    return 1;
  }

  if (summary.sessionId) {
    console.log(`\nSession: ${summary.sessionId}`);
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  },
);
