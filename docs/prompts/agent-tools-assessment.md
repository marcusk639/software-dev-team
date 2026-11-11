# Tools for the agent team: catalog and ratings

You are assessing which tools would make the agents in the `software-dev-team` repository better at their jobs. The repository owner will use your document to choose what to build next, so it has to do two things. It has to describe each candidate tool well enough that the owner can see what building it involves without re-researching it. And it has to rate each one consistently enough that the ranking can be trusted.

This is analysis only. Do not modify any existing file in the repository. The one file you create is the output document described at the end.

<context>
The repository is a TypeScript CLI built on the Claude Agent SDK. An orchestrator (the "Engineering Manager") breaks a task down and delegates it to ten specialist subagents. Each specialist has its own prompt file and its own tool set. The team works on *other* repositories, passed in with `--cwd`.

The codebase is small. Read every source file and every `prompt.md` in full, not excerpts. Many of the best tool ideas come from a single sentence in a role's prompt that asks for something its tools cannot do, and skimming misses those sentences. Also read the git history (`git log` with full message bodies). The commit messages record why design decisions were made, and those reasons constrain what a new tool may do.

What the SDK can do is defined by the installed package, not by what you remember. The type definitions under `node_modules/@anthropic-ai/claude-agent-sdk/` (mainly `sdk.d.ts` and `sdk-tools.d.ts`) document agent definitions, built-in tools, custom tools (`tool()`, `createSdkMcpServer`), external MCP servers, hook events and their inputs, sandbox settings and query options. Check every capability a recommendation depends on against those files and cite the line. If the types leave a question open, say so and say how it could be settled. A recommendation built on an API that does not exist costs the owner more time than leaving it out.

When a claim about current behavior can be checked cheaply without changing the repository, check it rather than reasoning about it. For example, you can import an exported function from a scratch script outside the repo and call it with sample inputs. Label which claims you observed and which you inferred.
</context>

<understand_first>
Build a full picture of the system before generating tool ideas. Ideas formed earlier tend to be generic, and they tend to work against the design. Establish:

- **Purpose and audience.** What the project is for and who runs it. Label goals stated in the repo (prompts, comments, usage text, commit messages) separately from goals you infer.
- **End-to-end flow.** Trace one task from the CLI entry point through argument parsing, prompt loading, the orchestrator, delegation, a subagent's tool calls, permission checks, and the final output. Give the file and line for each step.
- **Each role's job and toolset.** For each of the eleven agents (the orchestrator plus ten specialists), record what its prompt asks it to produce or verify, which tools it actually has, and where those two disagree. Disagreements between a prompt's demands and the agent's tools are the main source of candidates.
- **Design principles new tools must respect.** At minimum: how tool access is scoped per role and why; how the safety layer is enforced and why it lives where it does; the `--cwd` trust boundary; and keeping system prompts and tool definitions byte-stable across runs for prompt caching.
  </understand_first>

<generate_candidates>
Cast wide, then evaluate each candidate honestly. Include candidates from every kind below, because the cheapest fix is often not a new tool:

- giving a role a built-in tool it currently lacks, or taking one away;
- a custom in-process tool (`tool()` + `createSdkMcpServer`);
- an external MCP server;
- a hook (PreToolUse, PostToolUse, SubagentStop, Stop, and so on) that checks, records or redirects agent behavior;
- an SDK option that gives the agents a capability or a guardrail (sandboxing, budgets, resume, structured output, per-agent turn limits).

For each candidate, ask whether a prompt edit alone would close the same gap. If it would, say so and rate the tool down. Tools cost maintenance, context tokens and attack surface, and prompt edits cost almost nothing.

Treat tool output as untrusted input to the model. Any tool that brings in outside content (web pages, a target repo's files, database rows, a browser's DOM) opens a prompt-injection channel. Assess that channel against the roles that would receive it and the tools those roles hold.
</generate_candidates>

<rating_scale>
Rate every candidate on two separate dimensions so the owner can see why something ranks where it does. Use only these definitions; when you are between two levels, choose the lower one and say why.

**Usefulness (1–5)**: how much the tool improves the team's output, assuming it works.

- 5: Makes a core promise of the project actually hold. Without it, a guarantee the prompts or commit history make is not enforced or cannot be verified.
- 4: Lets a role do something its prompt requires and currently cannot do, on tasks that come up often.
- 3: Clearly improves quality or efficiency on a common class of tasks, but the team works acceptably without it.
- 2: Helps in a narrow set of tasks or target repos.
- 1: Speculative, or duplicates something a prompt edit or existing tool already covers.

**Priority**: what to do about it, after weighing usefulness against cost and risk.

- **P1 — build next**: high usefulness, small-to-moderate implementation, and no unresolved safety concern.
- **P2 — build after P1**: worthwhile, but larger, depends on a P1 item, or has a risk that needs a decision or experiment first. Name the blocker.
- **P3 — revisit later**: real value, but cost or risk outweighs it today. State what would change the call.
- **Don't build**: the gap is better closed another way, or the risk is not worth the benefit. Say what to do instead.
  </rating_scale>

<output>
Write the document to `docs/reports/agent-tools-assessment.md`, creating the directory if needed. Use Markdown with these sections:

1. **Summary.** Three to five sentences on the overall conclusion, followed by a table of every candidate sorted by priority, then usefulness. Columns: tool, kind, roles affected, usefulness, priority, one-line purpose.
2. **What the team is trying to achieve.** Purpose, audience, and the design principles from the understanding phase, with stated and inferred goals labeled. Keep it to what a reader needs to judge the tools.
3. **How a task flows.** A short numbered sequence with `path:line` references.
4. **Role-by-role capability gaps.** One entry per agent: what its prompt demands, which tools it has, and the gap, with `path:line` evidence. Say so when a role has no meaningful gap.
5. **Tool catalog.** One subsection per candidate, in the summary table's order, with these fields:
   - **Kind and roles**: what kind of change it is, and which agents get it or are constrained by it.
   - **Purpose**: the problem it solves, tied to a gap from section 4.
   - **What it achieves**: what the team can do or guarantee afterward that it cannot today. Be concrete: "qa-tester can show which test command ran and its exit status" rather than "better verification."
   - **How it would work**: the SDK mechanism, with `sdk.d.ts` line references, and a rough implementation size (tens, hundreds or thousands of lines).
   - **Impact**: effect on output quality; effect on the safety model (new attack surface, injection channels, interaction with the `--cwd` boundary and the existing hook); token, latency and dollar cost per run; and whether it changes system prompts or tool definitions between runs, which would break the prompt cache.
   - **Risks and open questions**: what could go wrong, and anything the SDK types do not settle.
   - **Rating**: usefulness and priority, each with a sentence explaining the level by reference to the scale.
   - **Smallest useful version**: for P1 and P2 only, the thinnest version worth shipping first.
6. **Prompt-only fixes.** Gaps that need only a prompt or tool-list edit rather than a new tool, each with the file, line and suggested change.
7. **Open questions for the owner.** Decisions only the owner can make that would change a rating.

Cite `path:line` for every claim about the code and `sdk.d.ts:line` for every claim about the SDK. If you conclude that only a few tools deserve a P1, report exactly that. A short, trustworthy P1 list is more useful to the owner than a long one they have to re-check.
</output>
