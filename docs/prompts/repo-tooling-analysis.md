# Repo analysis and tooling assessment

You are analyzing the `software-dev-team` repository to give its owner the understanding they need to decide which tools to invest in next. The owner knows the code well; what they want from you is an independent, evidence-backed read of what the project is trying to be, where it falls short of that, and which tools would close the gap. They will act on your recommendations, so a short list they can trust is worth more than a long list they have to re-check.

Do not modify the repository. This is analysis only; implementation decisions come after the owner reads your report.

<context>
The repository is a TypeScript CLI built on the Claude Agent SDK. It is small enough to read completely, so read every source file and every prompt file in full rather than sampling — conclusions about goals and gaps depend on details that skimming misses.

Ground truth for what the SDK can do is the installed package, not memory: read the type definitions under `node_modules/@anthropic-ai/claude-agent-sdk/` (they document custom tools, in-process MCP servers, hooks, agent definitions and options in detail). SDK capabilities change between versions, and a recommendation built on a remembered API that no longer exists wastes the owner's time.

The git history and commit messages record why things were built the way they were. Read them; they often state intent the code alone does not.
</context>

<phase name="understand">
Build a complete picture before thinking about tools, because tool ideas formed before you understand the goals tend to be generic and tend to fight the design.

Establish:

- **Goals.** What the project is for and who it serves. Separate goals the repo states (in code comments, prompts, usage text, commit messages) from goals you infer, and label which is which.
- **End-to-end flow.** Trace a task from the CLI entry point through argument parsing, prompt loading, the orchestrator, delegation to specialists, tool use, permission checks, and result rendering. Name the file and line for each hop.
- **Design principles.** The project encodes deliberate choices — for example how tool access is scoped per role, how the safety model is layered, where trust boundaries sit, how prompts are separated from code. Identify these and the reasons given for them, since any new tool must fit them.
- **Gaps.** Places where what an agent is asked to do outstrips what it can do or verify. Prompts are the best source here: when a role's instructions require evidence, measurement, or checks that its tools cannot produce, that is a gap. Also note gaps in the project's own development tooling.
</phase>

<phase name="assess_tools">
Only after the first phase, generate candidate tools. Cast wide first, then cut hard: the project's own stated preference is for deleting code over adding layers, and most candidates should not survive.

Consider candidates in two separate groups, because they have different costs and owners:

1. **Runtime capabilities for the agent team** — custom SDK tools, MCP servers, hooks, changes to which roles get which tools, or orchestration features.
2. **Development tooling for this repo** — tests, prompt evaluation, CI, or anything that helps the owner change prompts and code with confidence.

For each candidate, decide whether it is worth implementing by weighing:

- which goal or gap it serves, with the evidence (file:line) that the need is real rather than hypothetical;
- whether a prompt change or an existing tool already covers it — a tool that duplicates what a prompt edit achieves is not worth its maintenance;
- its effect on the safety model: new surface for a permission bypass, new untrusted input reaching the model (tool output is a prompt-injection channel), interaction with the `--cwd` trust boundary;
- its token and latency cost per run, and its effect on prompt caching (anything that makes system prompts or tool definitions vary between runs breaks the cache);
- implementation size, as a rough order of magnitude.

When you are unsure whether the SDK supports something, check the type definitions; if they don't settle it, say so rather than guessing.
</phase>

<output_format>
Write the report in Markdown with these sections:

1. **What this project is** — goals (stated vs. inferred, labeled), audience, and the design principles that constrain new work. A few paragraphs.
2. **How a task flows** — the end-to-end path as a short numbered sequence with `path:line` references.
3. **Gaps** — each gap with its evidence and why it matters.
4. **Candidate tools** — one table per group (runtime, development) with columns: tool, what it does, gap it serves, safety impact, cost, verdict (build / maybe / don't build).
5. **Recommendations** — the candidates marked "build", ranked, each with a paragraph covering the case for it, the main risk, and the smallest version worth shipping first.
6. **Considered and rejected** — the strongest rejected candidates and why, so the owner doesn't have to re-derive them.
7. **Open questions** — decisions only the owner can make that would change the recommendations.

Cite `path:line` for claims about the code. Mark anything you infer rather than observe as an inference. If the honest conclusion is that few or no new tools are worth building, say that — it is a useful result.
</output_format>
