import type {
  CanUseTool,
  HookCallbackMatcher,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import { createInterface } from "node:readline/promises";

/**
 * Commands that are never allowed, in any permission mode. Matched against the
 * raw Bash string so a compound command cannot smuggle one past the check.
 */
const HARD_DENY: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /\brm\s+(-\w*\s+)*-\w*[rf]/, why: "recursive or forced delete" },
  { pattern: /\bgit\s+push\b.*(--force|-f\b)/, why: "force push" },
  { pattern: /\bgit\s+reset\s+--hard\b/, why: "discards uncommitted work" },
  { pattern: /\bgit\s+clean\s+-\w*[fd]/, why: "deletes untracked files" },
  {
    pattern: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i,
    why: "destructive schema change",
  },
  {
    pattern: /\bcurl\b[^|]*\|\s*(ba)?sh\b/,
    why: "pipes a remote script to a shell",
  },
  { pattern: /\b(npm|pnpm|yarn)\s+publish\b/, why: "publishes to a registry" },
  { pattern: />\s*\/dev\/[sh]d[a-z]/, why: "writes to a raw device" },
];

/** Paths agents must not write, even inside the project. */
const PROTECTED_WRITE = [
  /(^|\/)\.env(\.|$)/,
  /(^|\/)(id_rsa|id_ed25519)(\.pub)?$/,
  /\.pem$/,
  /(^|\/)credentials\.json$/,
  /(^|\/)\.git\//,
];

/**
 * The same material as PROTECTED_WRITE, but matched as tokens inside a shell
 * command rather than as a whole path. PROTECTED_WRITE is anchored with (^|/)
 * and (\.|$), which never matches a filename sitting mid-command.
 */
const PROTECTED_IN_COMMAND = [
  /(^|[\s"'=|;&(<>])\.env\b/,
  /\bid_(rsa|ed25519)\b/,
  /\.pem\b/,
  /\bcredentials\.json\b/,
  /(^|[\s"'=|;&(<>])\.git\//,
];

const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function targetPath(input: Record<string, unknown>): string {
  return asString(input.file_path) || asString(input.notebook_path);
}

/**
 * The single source of truth for what is forbidden. Returns a reason when the
 * call must be blocked, or null when it is acceptable.
 */
function denyReason(
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  if (toolName === "Bash") {
    const command = asString(input.command);
    const hit = HARD_DENY.find((rule) => rule.pattern.test(command));
    if (hit) {
      return `Blocked by the team's safety policy (${hit.why}). If this is genuinely required, ask the human operator to run it directly.`;
    }
  }

  // A protected path can also be written straight from the shell, which never
  // reaches the Write tool. Redirection, tee, cp/mv and in-place sed all bypass
  // the file_path check below, so Bash is screened against the same list.
  if (toolName === "Bash") {
    const command = asString(input.command);
    const writesAFile =
      /(^|[^>])>{1,2}\s*\S/.test(command) ||
      /\b(tee|cp|mv|dd|install|truncate)\b/.test(command) ||
      /\bsed\b[^|]*-i/.test(command) ||
      /\b(chmod|chown)\b/.test(command);
    if (
      writesAFile &&
      PROTECTED_IN_COMMAND.some((pattern) => pattern.test(command))
    ) {
      return "That command writes to protected material (secrets or git internals). Ask the human operator to do it directly.";
    }
  }

  if (WRITE_TOOLS.has(toolName)) {
    const path = targetPath(input);
    if (PROTECTED_WRITE.some((pattern) => pattern.test(path))) {
      return `Writing to ${path} is not permitted (secret material or git internals).`;
    }
  }

  return null;
}

/**
 * The hard-deny list lives in a PreToolUse hook rather than in `canUseTool`
 * because `canUseTool` is skipped whenever the permission mode already
 * auto-approves a call — under `acceptEdits` or `bypassPermissions` it would
 * never see an Edit at all. The hook runs for every tool call in every mode,
 * so "yes to everything" still cannot mean "yes to rm -rf".
 */
export function createSafetyHooks(): Partial<
  Record<"PreToolUse", HookCallbackMatcher[]>
> {
  return {
    PreToolUse: [
      {
        hooks: [
          async (input) => {
            if (input.hook_event_name !== "PreToolUse")
              return { continue: true };
            const reason = denyReason(
              input.tool_name,
              (input.tool_input ?? {}) as Record<string, unknown>,
            );
            if (reason === null) return { continue: true };
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: reason,
              },
            };
          },
        ],
      },
    ],
  };
}

/**
 * Interactive approval for everything the hook did not already reject. Only
 * reached in `default` mode; `--yes` relies on the hook alone.
 */
export function createPermissionGate(): CanUseTool {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  return async (toolName, input): Promise<PermissionResult> => {
    const reason = denyReason(toolName, input);
    if (reason !== null) return { behavior: "deny", message: reason };

    const detail =
      toolName === "Bash"
        ? asString(input.command)
        : targetPath(input) || asString(input.pattern);

    const answer = await rl.question(
      `\n  ⚠  ${toolName}${detail ? `  ${detail.slice(0, 160)}` : ""}\n     allow? [y/N] `,
    );

    return answer.trim().toLowerCase() === "y"
      ? { behavior: "allow" }
      : {
          behavior: "deny",
          message: "The human operator declined this action.",
        };
  };
}

export const __testing = { denyReason };
