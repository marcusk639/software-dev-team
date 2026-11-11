#!/usr/bin/env node
import { DEFAULT_ALLOWED_TOOLS, prepareAllowRules } from "./allowlist.js";
import { checkProjectDir, type ParsedArgs, parseArgs, usage } from "./cli.js";
import { runOutcome } from "./outcome.js";
import { createRenderer } from "./render.js";
import {
  loadOrchestratorPrompt,
  ORCHESTRATOR,
  promptNames,
  runTeam,
} from "./orchestrator/index.js";
import type { ResolvedProfile } from "./profiles/compose.js";
import { BUILT_IN_PROFILES, resolveProfile } from "./profiles/registry.js";
import { loadProjectAgents } from "./project-agents.js";
import { CUSTOMIZATION_DIR, loadCustomizations } from "./prompts.js";
import { loadTeam, TEAM_CONVENTIONS } from "./team.js";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function describeProfile(profile: ResolvedProfile): string {
  return `profile ${profile.chain.join(" → ")}  (${profile.profile.name})`;
}

async function main(): Promise<number> {
  let cli: ParsedArgs;
  try {
    cli = parseArgs(process.argv.slice(2));
    if (cli.kind === "run" || cli.kind === "roles") checkProjectDir(cli.cwd);
    // Validated now so a bad --allow rule is a usage error, not a failure
    // mid-run. Its warnings are printed by runTeam, with the run's others.
    if (cli.kind === "run") {
      prepareAllowRules(DEFAULT_ALLOWED_TOOLS, cli.allow, { cwd: cli.cwd });
    }
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${usage()}`);
    return 2;
  }

  if (cli.kind === "help") {
    console.log(usage());
    return 0;
  }

  if (cli.kind === "profiles") {
    for (const profile of BUILT_IN_PROFILES) {
      const parent = profile.extends ? `  extends ${profile.extends}` : "";
      console.log(`${profile.id}${parent}\n  ${profile.summary}\n`);
    }
    return 0;
  }

  let profile: ResolvedProfile;
  try {
    profile = await resolveProfile({ selector: cli.profile, cwd: cli.cwd });
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }

  if (cli.kind === "roles") {
    // Loading every prompt here makes --roles a cheap check that none is
    // missing and that the profile and the project's customizations are valid.
    const customizations = loadCustomizations(cli.cwd, promptNames(profile));
    const team = loadTeam(customizations, profile);
    loadOrchestratorPrompt(customizations, profile);
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
    console.log(`${describeProfile(profile)}\n`);
    console.log(`${ORCHESTRATOR}${status(ORCHESTRATOR)}\n`);
    console.log(
      `${TEAM_CONVENTIONS}${status(TEAM_CONVENTIONS)}\n  Conventions shared by every specialist.\n`,
    );
    for (const [role, agent] of Object.entries(team)) {
      console.log(
        `${role}  [${agent.model ?? "default"}]${status(role)}\n  ${agent.description}\n`,
      );
    }
    // The same checks a run applies, so a rejected agent shows up here first.
    const project = loadProjectAgents(cli.cwd, Object.keys(team));
    for (const agent of project.agents) {
      console.log(
        `${agent.name}  [${agent.model ?? "default"}]  ${DIM}(project agent from .claude/agents)${RESET}\n`,
      );
    }
    for (const warning of project.warnings) console.error(warning);
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

  console.error(`${DIM}${describeProfile(profile)}${RESET}`);

  const summary = await runTeam({
    task: cli.task,
    cwd: cli.cwd,
    profile,
    autoApprove: cli.autoApprove,
    allow: cli.allow,
    resume: cli.resume,
    maxTurns: cli.maxTurns,
    maxBudgetUsd: cli.maxBudgetUsd,
    model: cli.model,
    onMessage: createRenderer({ verbose: cli.verbose }),
    onWarning: (warning) => console.error(`${DIM}${warning}${RESET}`),
  });

  if (summary.ledgerText) {
    console.log(`\n${DIM}What actually ran in this run:\n${summary.ledgerText}${RESET}`);
  }
  // Repeated here, next to the ledger, so they are not lost in the scrollback.
  if (summary.warnings.length > 0) {
    console.error(
      `\nConfiguration warnings for this run:\n${summary.warnings.map((w) => `- ${w}`).join("\n")}`,
    );
  }

  const outcome = runOutcome(summary, cli.strict);
  if (outcome.warning) console.error(`\n${outcome.warning}`);

  if (summary.isError) console.error(`\n${summary.result}`);

  // Printed on failure too: a run stopped by --max-turns is the one most worth resuming.
  if (summary.sessionId) {
    console.log(
      `\nSession: ${summary.sessionId}\n${DIM}Continue it with --resume ${summary.sessionId} "<message>" (same --cwd).${RESET}`,
    );
  }
  return outcome.code;
}

/**
 * Exits once stdout has drained: writes to a pipe are asynchronous on macOS,
 * and exiting straight away can cut off the ledger and the session id.
 */
function exitAfterFlush(code: number): void {
  process.stdout.write("", () => process.exit(code));
}

main().then(
  (code) => exitAfterFlush(code),
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
    exitAfterFlush(1);
  },
);
