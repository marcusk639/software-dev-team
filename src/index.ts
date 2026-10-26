#!/usr/bin/env node
import { DEFAULT_ALLOWED_TOOLS, resolveAllowedTools } from "./allowlist.js";
import { checkProjectDir, type Cli, parseArgs, usage } from "./cli.js";
import { createRenderer } from "./render.js";
import {
  loadOrchestratorPrompt,
  ORCHESTRATOR,
  PROMPT_NAMES,
  runTeam,
} from "./orchestrator/index.js";
import { CUSTOMIZATION_DIR, loadCustomizations } from "./prompts.js";
import { AGENTS, loadTeam, ROLES, TEAM_CONVENTIONS } from "./team.js";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

async function main(): Promise<number> {
  let cli: Cli | { help: true } | { roles: true; cwd: string };
  try {
    cli = parseArgs(process.argv.slice(2));
    if ("task" in cli) resolveAllowedTools(DEFAULT_ALLOWED_TOOLS, cli.allow);
    if (!("help" in cli)) checkProjectDir(cli.cwd);
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${usage()}`);
    return 2;
  }

  if ("help" in cli) {
    console.log(usage());
    return 0;
  }

  if ("roles" in cli) {
    // Loading every prompt here makes --roles a cheap check that none is
    // missing and that the project's customizations are valid.
    const customizations = loadCustomizations(cli.cwd, PROMPT_NAMES);
    loadTeam(customizations);
    loadOrchestratorPrompt(customizations);
    const status = (name: string) => {
      const custom = customizations.get(name);
      if (!custom) return "";
      const kinds = [
        custom.replace && "replaced",
        custom.sections &&
          `sections: ${Object.keys(custom.sections).join(", ")}`,
        custom.append && "extended",
      ].filter(Boolean);
      return `  ${DIM}(${kinds.join("; ")} by ${CUSTOMIZATION_DIR})${RESET}`;
    };
    console.log(`${ORCHESTRATOR}${status(ORCHESTRATOR)}\n`);
    console.log(
      `${TEAM_CONVENTIONS}${status(TEAM_CONVENTIONS)}\n  Conventions shared by every specialist.\n`,
    );
    for (const role of ROLES) {
      console.log(
        `${role}  [${AGENTS[role].model ?? "default"}]${status(role)}\n  ${AGENTS[role].description}\n`,
      );
    }
    return 0;
  }

  if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    // Not a hard gate: the SDK also authenticates from the credentials stored by
    // `claude login`, where neither variable is set.
    console.error(
      `${DIM}No ANTHROPIC_API_KEY set; using stored Claude Code credentials.${RESET}`,
    );
  }

  // Interactive mode blocks on a readline prompt, which never resolves without
  // a TTY; fail fast instead of hanging in CI or a pipe.
  if (!cli.autoApprove && !process.stdin.isTTY) {
    console.error(
      "No TTY available for approval prompts. Re-run with --yes to auto-approve.",
    );
    return 2;
  }

  const summary = await runTeam({
    task: cli.task,
    cwd: cli.cwd,
    autoApprove: cli.autoApprove,
    allow: cli.allow,
    resume: cli.resume,
    maxTurns: cli.maxTurns,
    maxBudgetUsd: cli.maxBudgetUsd,
    model: cli.model,
    onMessage: createRenderer({ verbose: cli.verbose }),
  });

  if (summary.ledgerText) {
    console.log(`\n${DIM}What actually ran:\n${summary.ledgerText}${RESET}`);
  }

  if (summary.isError) console.error(`\n${summary.result}`);

  // Printed on failure too: a run stopped by --max-turns is the one most worth resuming.
  if (summary.sessionId) {
    console.log(
      `\nSession: ${summary.sessionId}\n${DIM}Continue it with --resume ${summary.sessionId} "<message>" (same --cwd).${RESET}`,
    );
  }
  return summary.isError ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    // Configuration mistakes (a misnamed customization file, a missing prompt)
    // reach here; their message is what the user needs. DEBUG=1 shows the stack.
    console.error(
      error instanceof Error
        ? process.env.DEBUG
          ? error.stack
          : error.message
        : error,
    );
    process.exit(1);
  },
);
