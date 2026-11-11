import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { TeamRole } from "./agents/index.js";
import {
  genericProfile,
  joinBlocks,
  type ResolvedProfile,
  type TeamMember,
} from "./profiles/compose.js";
export { AGENTS, ROLES, type TeamRole } from "./agents/index.js";
export { TEAM_PLUGIN_DIR, TEAM_PLUGIN_NAME } from "./agents/shared.js";
import {
  applyCustomization,
  customizeBody,
  loadPrompt,
  type PromptCustomization,
  withAppended,
} from "./prompts.js";

/**
 * The name a project uses to customize the conventions every specialist
 * shares (.claude/dev-team/team.md and friends).
 */
export const TEAM_CONVENTIONS = "team";

const CONVENTIONS_FILE = new URL("./agents/team/prompt.md", import.meta.url);

/** A `<name>` block, refusing text that would close it early. */
function section(name: string, text: string, label: string): string {
  if (new RegExp(`^</${name}>$`, "m").test(text)) {
    throw new Error(
      `${label}'s <${name}> text contains its own closing </${name}> line, which would end the section early.`,
    );
  }
  return `<${name}>\n${text.trim()}\n</${name}>`;
}

function bullets(heading: string, items: readonly string[] | undefined) {
  return items?.length
    ? `## ${heading}\n${items.map((item) => `- ${item}`).join("\n")}`
    : undefined;
}

/**
 * A member's prompt before the project's customization files: its built-in
 * prompt with the profile's section overlays, then a <project> section with
 * the profile's context, expertise and standards. With no profile material
 * this is the built-in prompt unchanged.
 */
function profiledBody(
  name: string,
  member: TeamMember,
  profile: ResolvedProfile,
): string {
  const label = `The ${name} prompt`;
  const { overlay } = member;
  let body: string;
  if (member.promptFile) {
    const sections: Record<string, string> = {};
    if (overlay.identity) sections.role = overlay.identity;
    if (overlay.core) sections.standards = overlay.core;
    if (overlay.outputFormat) sections.output_format = overlay.outputFormat;
    body = customizeBody(loadPrompt(member.promptFile), { sections }, label);
    // The stack-neutral workflow belongs with the stack-neutral standards a
    // core replaces; leaving it would keep advice that does not fit the stack.
    if (overlay.core) {
      body = body.replace(/\n*^<workflow>\n[\s\S]*?\n<\/workflow>$/m, "");
    }
  } else {
    body = joinBlocks(
      section("role", overlay.identity!, label),
      section("standards", overlay.core!, label),
      overlay.outputFormat &&
        section("output_format", overlay.outputFormat, label),
    );
  }
  const project = joinBlocks(
    profile.context &&
      `## Project: ${profile.profile.name}\n\n${profile.context}`,
    overlay.context && `## Your role on this project\n\n${overlay.context}`,
    bullets("Specialist expertise", overlay.expertise),
    bullets("Project standards", overlay.standards),
  );
  return project ? `${body}\n\n${section("project", project, label)}` : body;
}

/**
 * Reads every agent's prompt from disk with the profile and the target
 * project's customizations applied; call once per run. Each specialist's
 * prompt is composed of, in order: its own sections (as the profile overlays
 * them, followed by the profile's <project> section), the shared team
 * conventions, and the project's instructions for that role. The role's own
 * project text comes last so it can refine anything above it.
 */
export function loadTeam(
  customizations?: ReadonlyMap<string, PromptCustomization>,
): Record<TeamRole, AgentDefinition>;
export function loadTeam(
  customizations: ReadonlyMap<string, PromptCustomization>,
  profile: ResolvedProfile,
): Record<string, AgentDefinition>;
export function loadTeam(
  customizations: ReadonlyMap<string, PromptCustomization> = new Map(),
  profile: ResolvedProfile = genericProfile(),
): Record<string, AgentDefinition> {
  const conventions = applyCustomization(
    loadPrompt(CONVENTIONS_FILE),
    customizations.get(TEAM_CONVENTIONS),
    "Conventions from this project",
  );
  return Object.fromEntries(
    Object.entries(profile.members).map(([role, member]) => {
      const { promptFile, overlay, ...definition } = member;
      const custom = customizations.get(role);
      const body = customizeBody(
        profiledBody(role, member, profile),
        custom,
        `The ${role} prompt`,
      );
      const prompt = withAppended(`${body}\n\n${conventions}`, custom?.append);
      return [role, { ...definition, prompt }];
    }),
  );
}
