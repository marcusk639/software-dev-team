import type { HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { actorOf } from "./permissions.js";
import { isOneOf, isRecord, WRITE_TOOLS } from "./tools.js";

/** The role whose tests are the run's acceptance contract. */
export const TEST_AUTHOR = "qa-tester";

/**
 * A test file, by the layouts test runners use: anything under `__tests__/`,
 * `test/`, `tests/`, `e2e/` or `maestro/`; `*.test.*`, `*.spec.*`, `*.e2e.*`
 * and Cypress's `*.cy.*` source files; Python's `test_*.py`, and the
 * `*_test.*` / `*_spec.*` names Go, Python and RSpec use; and the CamelCase
 * `*Test.*` / `*Tests.*` files and `*Tests/` projects of .NET, Xcode, Java
 * and Kotlin (`MyApp.Tests/UserTests.cs`, `androidTest/`). This covers the
 * test paths recovery-platform's own implementer gate protects. Only these
 * are locked: a source stub qa-tester adds so a test can load is the
 * engineer's to implement, and a snapshot or a document is not a test.
 */
const CODE = "(?:[cm]?[jt]sx?|py|rb|go|java|kts?|swift|dart|php|cs|rs|exs?)";
const TEST_PATH = new RegExp(
  [
    String.raw`(^|/)(__tests__|e2e|\.?maestro|tests?)/`,
    String.raw`\.(test|spec|e2e|cy)\.${CODE}$`,
    String.raw`(^|/)test_[^/]*\.py$`,
    String.raw`_(test|spec)\.${CODE}$`,
  ].join("|"),
  "i",
);
/**
 * Case-sensitive, so `Contest.cs` and `latest/` are not tests. A directory
 * counts only as a `*Tests/` project or Android's `androidTest/`, and a file
 * only in the languages that name tests this way, so an `ABTest/` or
 * `LoadTest/` directory and a TypeScript `ABTest.ts` model are not tests.
 */
const CAMEL_TEST_PATH = new RegExp(
  String.raw`(^|/)([^/]*Tests|androidTest)/|[A-Za-z0-9]Tests?\.(cs|swift|java|kts?|php)$`,
);

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path) || CAMEL_TEST_PATH.test(path);
}

/**
 * The path a file would have once every symlink is resolved, so `a/../x`,
 * `./x` and a symlinked directory all name the same file. A file that does
 * not exist yet resolves through its nearest existing parent.
 */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(canonical(parent), basename(path));
  }
}

/** The file's identity, whatever it is called: the same for a hard link, after a rename, and in any case on a case-insensitive filesystem. */
function identity(path: string): string | undefined {
  try {
    const stat = statSync(path);
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return undefined;
  }
}

const deny = (reason: string) => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse" as const,
    permissionDecision: "deny" as const,
    permissionDecisionReason: reason,
  },
});

/**
 * Keeps the tests qa-tester writes in a run as the acceptance contract: once
 * qa-tester has written a test file (isTestPath) with a file tool, any other
 * role's file-tool write to it is denied, so an engineer cannot reach green by editing the
 * test instead of the code. A write counts once it succeeded (PostToolUse).
 * A file is matched by its identity (device and inode), so a hard link, a
 * renamed directory or another case on a case-insensitive filesystem is
 * still the test, and by its path, so is a file deleted and written again.
 *
 * Best-effort like the shell rules: a shell write (`sed -i`, a redirect) is
 * not tracked by path. The manager tells code-reviewer which files are the
 * acceptance tests, and the operator's commit gate checks test changes.
 */
export function createTestAuthorship(options: {
  cwd: string;
  onDeny?: (toolUseId: string, reason: string) => void;
}): {
  hooks: Record<"PreToolUse" | "PostToolUse", HookCallbackMatcher[]>;
  /** The test files qa-tester wrote, relative to the project, sorted. */
  files: () => string[];
} {
  const root = canonical(resolve(options.cwd));
  const owned = new Set<string>();
  const ownedIds = new Set<string>();
  const pathOf = (input: unknown): string | undefined => {
    if (!isRecord(input)) return undefined;
    const path = input.file_path ?? input.notebook_path;
    return typeof path === "string" && path !== ""
      ? canonical(resolve(root, path))
      : undefined;
  };

  return {
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (input) => {
              if (
                input.hook_event_name !== "PreToolUse" ||
                !isOneOf(WRITE_TOOLS, input.tool_name)
              ) {
                return { continue: true };
              }
              const actor = actorOf(input);
              if (actor.kind !== "agent" || actor.type === TEST_AUTHOR) {
                return { continue: true };
              }
              const path = pathOf(input.tool_input);
              const id = path === undefined ? undefined : identity(path);
              if (
                path === undefined ||
                (!owned.has(path) && (id === undefined || !ownedIds.has(id)))
              ) {
                return { continue: true };
              }
              const why = `${relative(root, path)} is an acceptance test ${TEST_AUTHOR} wrote in this run, so only ${TEST_AUTHOR} may change it. Make it pass by changing the code under test. If the test itself is wrong, stop and report it as a spec gap; the manager routes it back to ${TEST_AUTHOR}.`;
              options.onDeny?.(input.tool_use_id, why);
              return deny(why);
            },
          ],
        },
      ],
      PostToolUse: [
        {
          hooks: [
            async (input) => {
              if (
                input.hook_event_name === "PostToolUse" &&
                isOneOf(WRITE_TOOLS, input.tool_name) &&
                actorOf(input).kind === "agent" &&
                input.agent_type === TEST_AUTHOR
              ) {
                const path = pathOf(input.tool_input);
                if (path !== undefined && isTestPath(relative(root, path))) {
                  owned.add(path);
                  const id = identity(path);
                  if (id !== undefined) ownedIds.add(id);
                }
              }
              return { continue: true };
            },
          ],
        },
      ],
    },
    files: () => [...owned].map((path) => relative(root, path)).sort(),
  };
}
