#!/usr/bin/env node
import { DEFAULT_ALLOWED_TOOLS, prepareAllowRules } from "./allowlist.js";
import { changedFiles } from "./changed-files.js";
import { checkProjectDir, type ParsedArgs, parseArgs, usage } from "./cli.js";
import { runOutcome } from "./outcome.js";
import { readFileSync } from "node:fs";
import { publish } from "./publish.js";
import { buildJsonResult, buildStartupErrorResult } from "./report.js";
import { createRenderer } from "./render.js";
import {
  loadOrchestratorPrompt,
  ORCHESTRATOR,
  promptNames,
  runTeam,
} from "./orchestrator/index.js";
import type { ResolvedProfile } from "./profiles/compose.js";
import {
  BUILT_IN_PROFILES,
  checkProfileRoot,
  resolveProfile,
} from "./profiles/registry.js";
import { loadProjectAgents } from "./project-agents.js";
import { CUSTOMIZATION_DIR, loadCustomizations } from "./prompts.js";
import { loadTeam, TEAM_CONVENTIONS } from "./team.js";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function describeProfile(profile: ResolvedProfile): string {
  return `profile ${profile.chain.join(" → ")}  (${profile.profile.name})`;
}

/**
 * Read from the raw arguments, so a run that fails before (or while) they
 * parse still answers an orchestrator in the format it asked for.
 */
const argv = process.argv.slice(2);
const JSON_OUTPUT = argv.some(
  (arg, i) => arg === "--output" && argv[i + 1] === "json",
);

/** --publish always answers in JSON, as an orchestrator's step. */
const PUBLISH = argv.includes("--publish");

/** A failure before the run started: a message on stderr, and in JSON mode a result object on stdout. */
function startupError(message: string, code: number, help = ""): number {
  console.error(help ? `${message}\n\n${help}` : message);
  if (PUBLISH) {
    console.log(
      JSON.stringify({ type: "publish", status: "failed", reason: message }),
    );
  } else if (JSON_OUTPUT) {
    console.log(JSON.stringify(buildStartupErrorResult(message, code)));
  }
  return code;
}

/** Exit codes for --publish: pushed, failed, nothing to publish. */
const PUBLISH_EXIT = { pushed: 0, failed: 1, skipped: 4 } as const;

async function main(): Promise<number> {
  let cli: ParsedArgs;
  try {
    cli = parseArgs(argv);
    if (cli.kind === "run" || cli.kind === "roles" || cli.kind === "publish") {
      checkProjectDir(cli.cwd);
    }
    // Validated now so a bad --allow rule is a usage error, not a failure
    // mid-run. Its warnings are printed by runTeam, with the run's others.
    if (cli.kind === "run") {
      prepareAllowRules(DEFAULT_ALLOWED_TOOLS, cli.allow, { cwd: cli.cwd });
    }
  } catch (error) {
    return startupError((error as Error).message, 2, usage());
  }

  if (cli.kind === "help") {
    console.log(usage());
    return 0;
  }

  if (cli.kind === "publish") {
    let result: unknown;
    try {
      result = JSON.parse(readFileSync(cli.resultFile, "utf8"));
    } catch (error) {
      return startupError(
        `--publish could not read ${cli.resultFile} as JSON: ${(error as Error).message}`,
        2,
      );
    }
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined;
    const outcome = publish({
      cwd: cli.cwd,
      branch: cli.branch,
      remote: cli.remote,
      result,
      includePartial: cli.includePartial,
      ...(cli.message === undefined ? {} : { message: cli.message }),
      ...(token === undefined ? {} : { token }),
    });
    if (outcome.reason) console.error(outcome.reason);
    console.log(JSON.stringify(outcome));
    return PUBLISH_EXIT[outcome.status];
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
    checkProfileRoot(profile, cli.cwd);
  } catch (error) {
    return startupError((error as Error).message, 2);
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
    const project = loadProjectAgents(
      cli.cwd,
      Object.keys(team),
      profile.shadowedProjectAgents,
    );
    for (const agent of project.agents) {
      console.log(
        `${agent.name}  [${agent.model ?? "default"}]  ${DIM}(project agent from .claude/agents)${RESET}\n`,
      );
    }
    for (const warning of project.warnings) console.error(warning);
    for (const notice of project.notices) {
      console.error(`${DIM}${notice}${RESET}`);
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
    return startupError(
      "No TTY available for approval prompts. Re-run with --yes to auto-approve.",
      2,
    );
  }

  // In JSON mode stdout carries only the result object; everything a person
  // reads goes to stderr.
  const json = cli.output === "json";
  const say = json
    ? (line: string) => console.error(line)
    : (line: string) => console.log(line);

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
    onMessage: createRenderer({ verbose: cli.verbose, log: say }),
    onWarning: (warning) => console.error(`${DIM}${warning}${RESET}`),
  });

  if (summary.ledgerText) {
    say(`\n${DIM}What actually ran in this run:\n${summary.ledgerText}${RESET}`);
  }
  if (summary.acceptanceTests.length > 0) {
    say(
      `\n${DIM}Acceptance tests qa-tester wrote (no other role could edit them with file tools):\n${summary.acceptanceTests.map((t) => `- ${t}`).join("\n")}${RESET}`,
    );
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
    say(
      `\nSession: ${summary.sessionId}\n${DIM}Continue it with --resume ${summary.sessionId} "<message>" (same --cwd).${RESET}`,
    );
  }
  if (json) {
    console.log(
      JSON.stringify(
        buildJsonResult({
          summary,
          exitCode: outcome.code,
          strict: cli.strict,
          needsCheck: outcome.needsCheck,
          warning: outcome.warning,
          profileChain: profile.chain,
          ledger: summary.ledger,
          ledgerFaults: summary.ledgerFaults,
          warnings: summary.warnings,
          notices: summary.notices,
          changedFiles: changedFiles(cli.cwd),
          acceptanceTests: summary.acceptanceTests,
        }),
      ),
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
    const message =
      error instanceof Error
        ? process.env.DEBUG
          ? (error.stack ?? error.message)
          : error.message
        : String(error);
    exitAfterFlush(startupError(message, 1));
  },
);
