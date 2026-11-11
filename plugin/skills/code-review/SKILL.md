---
name: code-review
description: How to review one code change in a review cycle, rating each finding by severity and confidence so fixes converge. Adapted from the iterative-review method for a single reviewer whose manager runs the fix cycles. Use when reviewing a change or re-verifying fixes to one.
---

# Code review

You review a change; engineers fix what you find; you verify the fixes; the cycle repeats until nothing blocking is left. Your manager runs the cycles and routes the fixes. This skill is how you review within one cycle so the findings are actionable and the cycles converge, usually in two or three.

## Find the change

Run `git status`, `git diff` and `git diff --staged`, and read new files in full. Review what your brief names; if it names nothing, review every changed file. Read the callers and the surrounding code before judging, and read the repository's own conventions (CLAUDE.md, CONTRIBUTING.md, lint and format config) rather than assuming a stack.

Run the cheap checks that exist (type check, linter, the tests covering the change) and use their output as evidence. If a command is refused, say so and review without it.

## Check by what the code does

Classify each changed file by what it actually does, not by its folder, and apply the checks for that kind of code. A change often spans several.

| Kind of code         | What to check                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| UI and components    | Every state handled (loading, empty, error), accessibility, untrusted input never rendered as HTML     |
| State and data flow  | Mutation of shared state, cache invalidation, stale reads, ordering                                    |
| Backend and services | Input validated at the boundary, errors propagated with context, contracts kept, idempotent retries    |
| Data access          | Parameterized queries, transactions around multi-step writes, N+1 queries, index use, migration safety |
| Security-sensitive   | Authorization on every path, token and session handling, secrets kept out of code and logs             |
| Payments and money   | Amounts computed and checked on the server, idempotency, rounding and currency, refund limits          |
| Infra and config     | Secrets, least privilege, environment differences, defaults that are unsafe in production              |

## Rate every finding

Severity says what happens if it ships:

- **CRITICAL**: data loss, a security hole, or a crash on a common path.
- **HIGH**: wrong behavior a user or caller will hit, or a failure that is swallowed.
- **MEDIUM**: an edge case, a fragile construction, or a gap that will cause a defect later.
- **LOW**: a minor issue worth noting.

Confidence (0-100) says how sure you are that the issue is real and reachable, after you checked it. A finding below 85 counts as LOW whatever its severity: a blocking finding has to be one an engineer can act on without re-investigating it. A CRITICAL at 60 is less actionable than a HIGH at 92.

Only CRITICAL and HIGH findings at confidence 85 or above block. The change is clean when none are open. MEDIUM and LOW findings are follow-ups, not fixed mid-cycle, because fixing them can introduce new blocking defects.

## Score each changed file

Score each changed file 0-10 on five dimensions:

| Dimension              | What to check                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------- |
| Functional correctness | Does it do what it is meant to? Logic errors, off-by-one, inverted comparisons.     |
| Data integrity         | Field names and types consistent between what writes and what reads; safe defaults. |
| Error handling         | Errors caught at the right level and handled, not swallowed.                        |
| Edge cases             | Null, undefined, empty collections, missing fields, concurrent access.              |
| Integration safety     | Signatures, return types and field names match their callers and consumers.         |

A file's confidence is its lowest score × 10, not the average. A file scoring 9 everywhere but 3 on edge cases has confidence 30: one severe weakness is not offset by strength elsewhere.

## Re-review

When your brief lists fixes from an earlier cycle, verify those first: each resolves its finding and introduces no new defect. Don't re-review unchanged code exhaustively, and don't re-raise a finding the brief marks as a deliberate choice. Report any new CRITICAL or HIGH finding the fixes caused. If the same finding keeps coming back across cycles, say so; it usually means the scope is too large or the fix is regressing.

## What not to flag

Deliberate design choices, style the formatter owns, and problems in code the change didn't touch, unless the change makes them worse. Report only genuine issues, in the output format your role defines.
