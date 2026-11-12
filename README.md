# software-dev-team

An autonomous software development team built on the Claude Agent SDK. An Engineering Manager agent decomposes a task and delegates it to specialists: product manager, architect, UX designer, backend, frontend and mobile engineers, database specialist, QA, code reviewer, monetization and strategy.

- **Test-first.** qa-tester turns the acceptance criteria into failing tests before an engineer starts, and only qa-tester can edit those tests with file tools.
- **Evidence over assurance.** A harness ledger records every command and file change. The manager holds each result to it (a test seen failing, then passing) before reporting it done.
- **Safe by construction.** A safety hook screens every tool call in every mode. Deploys, pushes, reading secrets and file-tool writes outside the project are blocked whatever the allow rules say. The rules are best-effort pattern matching, so the container is the real boundary; [docs/security.md](docs/security.md) lists the known gaps.
- **Configured per project.** A profile turns the stack-neutral team into specialists who know a project's technologies, conventions, commands and invariants.
- **Built to run unattended.** One JSON result for an orchestrator such as Hermes, a hardened Docker image, and a model-free step that commits and pushes the finished work.

## Quick start

You need Node 22, pnpm, git and a Claude credential (`ANTHROPIC_API_KEY`, or a logged-in Claude Code).

```bash
pnpm install
pnpm start --cwd ../recovery-platform --profile regroup "Add a CSV export of payment history for operators"
```

```bash
pnpm start --profiles                                            # the built-in profiles
pnpm start --roles --cwd ../recovery-platform --profile regroup  # the team that would run there
pnpm start --help                                                # every option
```

The team edits real files in `--cwd` and leaves them uncommitted for you to review. It also loads that repository's `.claude` settings and hooks, so point it only at repositories you trust.

For an orchestrator, run it unattended with one JSON result, then publish the branch:

```bash
pnpm start --output json --yes --strict --max-budget 5 --cwd ../recovery-platform --profile regroup --file task.md > result.json
GITHUB_TOKEN=… pnpm start --publish result.json --branch hco/42-export --cwd ../recovery-platform
```

## Built-in profiles

| Profile             | Extends             | What it adds                                                                                                                                                                |
| ------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generic`           | —                   | Nothing: the stack-neutral team. The default.                                                                                                                               |
| `recovery-platform` | —                   | Monorepo-wide rules: product data isolation through recovery-api, per-product vocabulary, PII-free logging, secrets, emulator ports, coverage ratchets, commit conventions. |
| `regroup`           | `recovery-platform` | Specializes every role for Regroup, and adds a `web-engineer` for the Angular 9 portal.                                                                                     |

The profile is detected from `--cwd` when you don't name one. You can also pass your own as a module: `--profile ./team-profile.ts`.

## Documentation

| Guide                                   | For                                                                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Using the team](docs/usage.md)         | Running it, reading its report, `--resume`, JSON output and exit codes, `--allow`, per-project prompt customization, `--publish`, troubleshooting |
| [Deployment](docs/deployment.md)        | Running it unattended in Docker under Hermes: the image, credentials, the result contract, limits                                                 |
| [How it works](docs/architecture.md)    | A run step by step, the source map, prompts, profiles, the safety layer, the ledger                                                               |
| [Extending the team](docs/extending.md) | Writing profiles, adding roles, tools, pre-approved commands, safety rules and skills                                                             |
| [Testing](docs/testing.md)              | Running and writing tests, and the live checks                                                                                                    |
| [Contributing](docs/CONTRIBUTING.md)    | Setup, conventions, the PR checklist, PR automation                                                                                               |
| [Security](docs/security.md)            | What protects a run, and every known way around it                                                                                                |

[docs/README.md](docs/README.md) indexes everything, including the dated reviews and design records.

## Development

```bash
pnpm typecheck
pnpm test
```

No CI runs these, so run both before every pull request. See [CONTRIBUTING.md](docs/CONTRIBUTING.md).
