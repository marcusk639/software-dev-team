#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createRenderer } from "./render.js";
import { runTeam } from "./orchestrator.js";
import type { ResolvedTeam } from "./profiles/compose.js";
import { BUILT_IN_PROFILES, resolveTeam } from "./profiles/registry.js";

interface Cli {
  task: string;
  cwd: string;
  profile?: string | undefined;
  autoApprove: boolean;
  verbose: boolean;
  maxTurns?: number | undefined;
  model?: string | undefined;
}

function usage(): string {
  return `software-dev-team — an autonomous software development team

  pnpm start "<task>"                  delegate a task to the team
  pnpm start --file ./task.md          read the task from a file
  pnpm start --roles                   list the resolved specialists and exit
  pnpm start --profiles                list the built-in project profiles and exit

Options
  --cwd <path>        project the team works in (default: current directory)
  --profile <id|path> project profile: a built-in id, or a path to a profile
                      module (default: detected from --cwd, else "generic")
  --yes               auto-approve tool use (destructive commands stay blocked)
  --verbose           show tool results, not just tool calls
  --max-turns <n>     cap agentic turns
  --model <name>      override the orchestrator model (e.g. opus, sonnet)

The team reads and writes real files in --cwd. Point it at a project directory,
not at this one, unless you mean for it to edit itself.`;
}

type Listing = {
  list: "roles" | "profiles";
  cwd: string;
  profile?: string | undefined;
};

function parseArgs(argv: string[]): Cli | Listing | { help: true } {
  const positional: string[] = [];
  let cwd = process.cwd();
  let profile: string | undefined;
  let list: Listing["list"] | undefined;
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
        list = "roles";
        break;
      case "--profiles":
        list = "profiles";
        break;
      case "--profile":
        profile = expect(argv, ++i, "--profile");
        break;
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

  if (list) return { list, cwd, profile };

  const task = file
    ? readFileSync(file, "utf8").trim()
    : positional.join(" ").trim();
  if (!task) return { help: true };

  return { task, cwd, profile, autoApprove, verbose, maxTurns, model };
}

function expect(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function describeProfile(team: ResolvedTeam): string {
  return `profile ${team.chain.join(" → ")}  (${team.profile.name})`;
}

async function main(): Promise<number> {
  let cli: Cli | Listing | { help: true };
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

  if ("list" in cli && cli.list === "profiles") {
    for (const profile of BUILT_IN_PROFILES) {
      const parent = profile.extends ? `  extends ${profile.extends}` : "";
      console.log(`${profile.id}${parent}\n  ${profile.summary}\n`);
    }
    return 0;
  }

  let team: ResolvedTeam;
  try {
    team = await resolveTeam({ selector: cli.profile, cwd: cli.cwd });
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }

  if ("list" in cli) {
    console.log(`${describeProfile(team)}\n`);
    for (const [role, agent] of Object.entries(team.agents)) {
      console.log(
        `${role}  [${agent.model ?? "default"}]\n  ${agent.description}\n`,
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

  console.error(`\x1b[2m${describeProfile(team)}\x1b[0m`);

  const summary = await runTeam({
    task: cli.task,
    team,
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
