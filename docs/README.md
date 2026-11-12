# Documentation

Start with the guide that matches what you're doing.

| I want to …                                                            | Read                                                                                                 |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Run the team on a project, read its report, tune it for that project   | [usage.md](usage.md)                                                                                 |
| Run it unattended in Docker under Hermes or another orchestrator       | [deployment.md](deployment.md): the image, credentials, the JSON result contract, publishing, limits |
| Understand how a run works inside                                      | [architecture.md](architecture.md)                                                                   |
| Add a profile, a role, a tool, a pre-approved command or a safety rule | [extending.md](extending.md)                                                                         |
| Run, write or extend the tests                                         | [testing.md](testing.md)                                                                             |
| Set up the repo, follow its conventions, open a PR                     | [CONTRIBUTING.md](CONTRIBUTING.md)                                                                   |
| Know what protects a run, and every known way around it                | [security.md](security.md)                                                                           |

**Suggested reading order.**

- To use the team: usage, then deployment, then security.
- To change it: architecture, then extending, testing and CONTRIBUTING, then security.

## Current guides

| Doc                                | Covers                                                                                                                                                                                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [usage.md](usage.md)               | Prerequisites, first run, profiles, interactive vs `--yes`, the trace and report, `--resume`, JSON output and exit codes, `--allow`, `.claude/dev-team/` customizations, project agents, `--publish`, command and environment reference, troubleshooting |
| [deployment.md](deployment.md)     | The operations runbook for unattended runs: the model, building the image, credentials, preparing a checkout, running a job, the result contract, driving it from Hermes, what can be verified in a container, limits                                    |
| [architecture.md](architecture.md) | A run step by step, a source map, the team, prompt assembly, profile composition, the safety layer, the ledger and test lock, publishing, trust boundaries                                                                                               |
| [extending.md](extending.md)       | Which layer to change; profiles; profile and built-in roles; tools; allow rules; safety rules; skills; the result contract; cross-file contracts                                                                                                         |
| [testing.md](testing.md)           | Commands, how the suite is organized, conventions and helpers, writing tests per area, environment caveats, live and manual checks, what runs on GitHub                                                                                                  |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Setup, scripts, layout, conventions, the PR checklist, PR automation and secrets                                                                                                                                                                         |
| [security.md](security.md)         | The security model and the register of known gaps (S1–S12), with status, mitigation and fix, and a checklist for safety changes                                                                                                                          |

## Records

These are dated records: reviews, plans, prompts given to agents, and their reports. They describe the code at the time they were written, and each says which commit it describes when that matters. Read them for the reasoning behind a decision. Check any claim about current behavior against the source or the guides above.

| Doc                                                                                                                                                                        | What it is                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [reviews/2026-11-10-standalone-readiness.md](reviews/2026-11-10-standalone-readiness.md)                                                                                   | The review that made the team ready to run unattended under Hermes in Docker, including recommended next steps (the supervised live trial, the SDK upgrade) |
| [specs/pr-reviewer-design.md](specs/pr-reviewer-design.md)                                                                                                                 | Design of the repo-aware PR reviewer (2026-10-26)                                                                                                           |
| [plans/pr-reviewer.md](plans/pr-reviewer.md)                                                                                                                               | Its implementation plan                                                                                                                                     |
| [plans/pr-reviewer-runbook.md](plans/pr-reviewer-runbook.md)                                                                                                               | The GitHub steps that rolled it out. It names a `chore/pr-review` branch and worktree, both since merged and removed.                                       |
| [reports/pr-reviewer-project-brief.md](reports/pr-reviewer-project-brief.md)                                                                                               | The project brief behind the reviewer design (at commit `9fdc3fb`)                                                                                          |
| [prompts/agent-tools-assessment.md](prompts/agent-tools-assessment.md), [reports/agent-tools-assessment.md](reports/agent-tools-assessment.md)                             | The brief for, and the report of, an assessment of tools for the agent team (at commit `09f238e`)                                                           |
| [prompts/agent-tools-assessment-review.md](prompts/agent-tools-assessment-review.md), [reports/agent-tools-assessment-review.md](reports/agent-tools-assessment-review.md) | The brief for, and the report of, a review of that assessment                                                                                               |
| [prompts/repo-tooling-analysis.md](prompts/repo-tooling-analysis.md)                                                                                                       | A brief for an independent repository and tooling analysis                                                                                                  |
