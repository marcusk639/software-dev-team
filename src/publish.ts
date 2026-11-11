import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "./tools.js";
import { isSecretPath } from "./permissions/paths.js";

/**
 * Commits a finished run's changes on a branch and pushes it: the step that
 * turns a team run into something on GitHub. It runs no model. It is meant to
 * run as its own process (docs/deployment.md), so the GitHub write token it
 * needs is never in a process where an agent could read it; the team itself
 * still cannot push.
 *
 * It publishes only a run whose manager reported done (or partial, when
 * asked), only to a branch that is not the remote's default branch, never
 * with force, and never a file that holds secrets. The repository's own
 * commit and pre-push hooks run, so its gates apply, but never with the
 * token: they run the repository's code, which the team may have written
 * (recovery-platform's pre-push runs each changed package's tests).
 */
export interface PublishOptions {
  cwd: string;
  branch: string;
  /** Default "origin". */
  remote?: string;
  /** The JSON object a `--output json` run printed. */
  result: unknown;
  /** Also publish a run whose outcome is partial. */
  includePartial?: boolean;
  /** Used instead of the manager's suggested commit message. */
  message?: string;
  /** A GitHub token for an https remote (GITHUB_TOKEN or GH_TOKEN). */
  token?: string;
}

export interface PublishResult {
  type: "publish";
  status: "pushed" | "skipped" | "failed";
  reason: string | null;
  branch: string;
  remote: string;
  commit: string | null;
  files: string[];
}

const DEFAULT_NAMES = new Set(["main", "master"]);

function git(
  cwd: string,
  args: string[],
  options: {
    input?: string;
    /** Default: this process's environment without the GitHub token. */
    env?: NodeJS.ProcessEnv;
    raw?: boolean;
  } = {},
): string {
  const out = execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    ...(options.input === undefined ? {} : { input: options.input }),
    // Never the token by default: a switch, an add or a reset can run the
    // repository's hooks (reference-transaction, post-checkout) too.
    env: options.env ?? withoutToken(process.env, undefined),
  });
  // Porcelain output starts with a status column that may be a space.
  return options.raw ? out : out.trim();
}

/** The tail of a failed git command's output, for the reason. */
function failure(error: unknown): string {
  const e = error as { stderr?: string; stdout?: string; message?: string };
  const text =
    `${e.stderr ?? ""}\n${e.stdout ?? ""}`.trim() || e.message || String(error);
  return text.split("\n").slice(-6).join("\n");
}

/**
 * The environment for `git push` with a token: an Authorization header for
 * github.com through git's GIT_CONFIG_* variables (as actions/checkout does),
 * so the token appears in no command line, plus no credential helper and no
 * prompt, so a missing or wrong token fails instead of waiting for input.
 */
export function pushEnvironment(
  token: string | undefined,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, GIT_TERMINAL_PROMPT: "0" };
  if (!token) return env;
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    ...env,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${basic}`,
  };
}

/**
 * The environment without the GitHub token, for anything that runs the
 * repository's code (its hooks). Drops GITHUB_TOKEN, GH_TOKEN and any other
 * variable holding the token's value.
 */
export function withoutToken(
  env: NodeJS.ProcessEnv,
  token: string | undefined,
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === "GITHUB_TOKEN" || key === "GH_TOKEN") continue;
    if (token && value?.includes(token)) continue;
    clean[key] = value;
  }
  return clean;
}

const ZERO = "0".repeat(40);

/**
 * Runs the pre-push hook as `git push` would (the remote and its URL as
 * arguments, the ref line on stdin) but in an environment without the
 * token. The push itself then runs no hook at all (--no-verify, and an empty
 * hooks path for reference-transaction): any token git can push with is
 * readable by the hooks git push runs.
 */
function prePush(
  root: string,
  remote: string,
  branch: string,
  commit: string,
  env: NodeJS.ProcessEnv,
  pushEnv: NodeJS.ProcessEnv,
): void {
  let remoteSha = ZERO;
  try {
    remoteSha =
      git(root, ["ls-remote", remote, `refs/heads/${branch}`], {
        env: pushEnv,
      }).split(/\s/)[0] || ZERO;
  } catch {
    // The push reports an unreachable remote; the hook sees a new branch.
  }
  const url = git(root, ["remote", "get-url", remote]);
  const dir = mkdtempSync(join(tmpdir(), "sdt-pre-push-"));
  try {
    const stdin = join(dir, "refs");
    writeFileSync(
      stdin,
      `refs/heads/${branch} ${commit} refs/heads/${branch} ${remoteSha}\n`,
    );
    git(
      root,
      [
        "hook",
        "run",
        "--ignore-missing",
        `--to-stdin=${stdin}`,
        "pre-push",
        "--",
        remote,
        url,
      ],
      { env },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The changed paths, relative to the repository root, sorted. */
function changes(root: string): string[] {
  const out = git(root, [
    "--no-optional-locks",
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ], { raw: true });
  const fields = out.split("\0");
  const paths = new Set<string>();
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i]!;
    if (field.length < 4) continue;
    paths.add(field.slice(3));
    if (field[0] === "R" || field[0] === "C") i += 1; // the rename's source
  }
  return [...paths].sort();
}

function remoteDefaultBranch(root: string, remote: string): string | null {
  try {
    const ref = git(root, [
      "symbolic-ref",
      "--short",
      `refs/remotes/${remote}/HEAD`,
    ]);
    return ref.startsWith(`${remote}/`) ? ref.slice(remote.length + 1) : ref;
  } catch {
    return null;
  }
}

/** The run's own record, as the commit body, so the branch says where it came from. */
function commitBody(
  result: Record<string, unknown>,
  team: Record<string, unknown>,
): string {
  const tests = Array.isArray(team.acceptance_tests)
    ? team.acceptance_tests.filter((t): t is string => typeof t === "string")
    : [];
  const lines = [
    `Published from software-dev-team run ${String(result.session_id ?? "unknown")}, outcome ${String(team.outcome)}.`,
  ];
  if (tests.length) {
    lines.push(
      "",
      "Acceptance tests (written by qa-tester before the implementation):",
      ...tests.map((t) => `- ${t}`),
    );
  }
  return lines.join("\n");
}

export function publish(options: PublishOptions): PublishResult {
  const remote = options.remote ?? "origin";
  const branch = options.branch;
  const done = (
    status: PublishResult["status"],
    reason: string | null,
    extra: Partial<PublishResult> = {},
  ): PublishResult => ({
    type: "publish",
    status,
    reason,
    branch,
    remote,
    commit: null,
    files: [],
    ...extra,
  });

  const { result } = options;
  if (!isRecord(result) || result.type !== "result" || !isRecord(result.team)) {
    return done(
      "failed",
      "not a software-dev-team result (run with --output json and pass its stdout)",
    );
  }
  const team = result.team;
  if (result.is_error === true) {
    return done(
      "skipped",
      `the run failed (${String(result.subtype)}); nothing is published`,
    );
  }
  const outcome = team.outcome;
  if (outcome === "partial" && !options.includePartial) {
    return done(
      "skipped",
      "the run is partial; pass --include-partial to publish it anyway",
    );
  }
  if (outcome !== "done" && outcome !== "partial") {
    return done("skipped", `the run's outcome is ${String(outcome)}, not done`);
  }

  let root: string;
  try {
    root = git(options.cwd, ["rev-parse", "--show-toplevel"]);
    git(root, ["check-ref-format", "--branch", branch]);
  } catch (error) {
    return done(
      "failed",
      branch
        ? `not a usable branch or checkout: ${failure(error)}`
        : "no branch given",
    );
  }
  if (/\s/.test(branch) || branch.startsWith("-")) {
    return done("failed", `"${branch}" is not a usable branch name`);
  }
  const defaultBranch = remoteDefaultBranch(root, remote);
  if (DEFAULT_NAMES.has(branch) || branch === defaultBranch) {
    return done(
      "failed",
      `${branch} is the default branch; publish only to a branch for review`,
    );
  }

  const files = changes(root);
  if (files.length === 0) return done("skipped", "nothing to commit");
  const secret = files.find((file) => isSecretPath(root, file));
  if (secret) {
    return done(
      "failed",
      `refusing to commit ${secret}: it looks like it holds secrets`,
      { files },
    );
  }

  const message =
    (
      options.message ??
      (typeof team.commit_message === "string" ? team.commit_message : "")
    ).trim() ||
    `chore: changes from software-dev-team run ${String(result.session_id ?? "")}`.trim();
  if (message.includes("\n"))
    return done("failed", "the commit message must be one line", { files });

  // A git identity for the commit when the environment and config have none.
  // No token: the commit runs the repository's hooks.
  const env = withoutToken(process.env, options.token);
  let configured = false;
  try {
    configured = git(root, ["config", "user.email"]) !== "";
  } catch {
    configured = false;
  }
  if (!configured && !env.GIT_AUTHOR_EMAIL) {
    env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = "software-dev-team";
    env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL =
      "software-dev-team@users.noreply.github.com";
  }

  let commit: string;
  try {
    const current = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (current !== branch) {
      const exists = (() => {
        try {
          git(root, [
            "rev-parse",
            "--verify",
            "--quiet",
            `refs/heads/${branch}`,
          ]);
          return true;
        } catch {
          return false;
        }
      })();
      git(
        root,
        exists
          ? ["switch", "--quiet", branch]
          : ["switch", "--quiet", "--create", branch],
      );
    }
    git(root, ["add", "--all", "--", ":/"]);
    // What is staged is what gets committed: check it, not only what status said.
    const staged = git(root, ["diff", "--cached", "--name-only", "-z"])
      .split("\0")
      .filter(Boolean);
    const stagedSecret = staged.find((file) => isSecretPath(root, file));
    if (stagedSecret) {
      git(root, ["reset", "--quiet"]);
      return done(
        "failed",
        `refusing to commit ${stagedSecret}: it looks like it holds secrets`,
        { files },
      );
    }
    git(root, ["commit", "--quiet", "--file", "-"], {
      input: `${message}\n\n${commitBody(result, team)}\n`,
      env,
    });
    commit = git(root, ["rev-parse", "HEAD"]);
  } catch (error) {
    return done("failed", `commit failed: ${failure(error)}`, { files });
  }

  const pushEnv = pushEnvironment(options.token, env);
  try {
    prePush(root, remote, branch, commit, env, pushEnv);
  } catch (error) {
    return done(
      "failed",
      `committed ${commit.slice(0, 12)} on ${branch}, but the pre-push hook rejected it, so nothing was pushed: ${failure(error)}`,
      { files, commit },
    );
  }
  try {
    git(
      root,
      [
        // No hooks at all while the token is in git's environment:
        // --no-verify skips only pre-push, and updating the remote-tracking
        // ref would still run reference-transaction.
        "-c",
        "core.hooksPath=/dev/null",
        "push",
        "--quiet",
        "--no-verify",
        remote,
        `HEAD:refs/heads/${branch}`,
      ],
      { env: pushEnv },
    );
  } catch (error) {
    return done(
      "failed",
      `committed ${commit.slice(0, 12)} on ${branch}, but the push failed (never forced): ${failure(error)}`,
      {
        files,
        commit,
      },
    );
  }
  return done("pushed", null, { files, commit });
}
