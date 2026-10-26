import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Prompts are read from disk when a run starts, so editing a `.md` file takes
 * effect on the next run. A leading BOM is dropped, CRLF/CR become LF, and all
 * trailing newlines are stripped, so the same prompt yields the same bytes on
 * every platform and editor: any drift between runs would invalidate the
 * prompt cache.
 */
export function loadPrompt(file: URL): string {
  const raw = readFileSync(file, "utf8");
  const text = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
    .replace(/\r\n?/g, "\n")
    .replace(/\n+$/, "");
  if (text.trim() === "") {
    throw new Error(`Prompt file is empty: ${fileURLToPath(file)}`);
  }
  return text;
}

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

/**
 * Fills `{{name}}` placeholders. A template that cannot be filled exactly — an
 * unknown name, a malformed one like `{{ name }}`, or a stray `{{` / `}}` —
 * is an error, not a silent gap in the prompt.
 */
export function renderPrompt(
  template: string,
  values: Record<string, string>,
): string {
  if (/\{\{|\}\}/.test(template.replace(PLACEHOLDER, ""))) {
    throw new Error("Prompt has an unbalanced {{ or }}");
  }
  return template.replace(PLACEHOLDER, (_, name: string) => {
    if (!/^\w+$/.test(name)) {
      throw new Error(`Prompt placeholder {{${name}}} is malformed`);
    }
    if (!Object.hasOwn(values, name)) {
      throw new Error(`Prompt placeholder {{${name}}} has no value`);
    }
    return values[name]!;
  });
}

/** A project's changes to one built-in prompt. */
export interface PromptCustomization {
  /** Used instead of the built-in prompt. */
  replace?: string;
  /** Replacements for individual <section> blocks, keyed by section name. */
  sections?: Record<string, string>;
  /** Added after the prompt, under its own heading. */
  append?: string;
}

/**
 * Where a project customizes the team, relative to --cwd. Under `.claude/`,
 * which the safety hook keeps agents from writing, so the team cannot edit its
 * own instructions. The directory is part of the --cwd trust boundary.
 */
export const CUSTOMIZATION_DIR = join(".claude", "dev-team");

/** `<name>.md`, `<name>.replace.md` or `<name>.<section>.md`. Names hold no dots. */
const CUSTOMIZATION_FILE = /^([^.]+)(?:\.(\w+))?\.md$/;

/**
 * Reads a project's prompt customizations: `<name>.md` is appended,
 * `<name>.replace.md` replaces the whole prompt and `<name>.<section>.md`
 * replaces one <section> block. A file that matches no known name is an error
 * rather than silently ignored, since a typo would otherwise drop the
 * instruction without notice. README.md is left for the project's own notes,
 * and dotfiles (.DS_Store, editor swap files) and directories are skipped.
 */
export function loadCustomizations(
  cwd: string,
  names: readonly string[],
): Map<string, PromptCustomization> {
  const dir = join(cwd, CUSTOMIZATION_DIR);
  let files: string[];
  try {
    files = readdirSync(dir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          !entry.name.startsWith(".") &&
          entry.name !== "README.md",
      )
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }

  const known = new Set(names);
  const customizations = new Map<string, PromptCustomization>();
  for (const file of files.sort()) {
    const match = CUSTOMIZATION_FILE.exec(file);
    const name = match?.[1];
    if (!match || name === undefined || !known.has(name)) {
      throw new Error(
        `${join(dir, file)} does not match a prompt. Name it <name>.md to append, <name>.replace.md to replace or <name>.<section>.md to replace one section, where <name> is one of: ${names.join(", ")}.`,
      );
    }
    const text = loadPrompt(pathToFileURL(join(dir, file)));
    const entry = customizations.get(name) ?? {};
    const section = match[2];
    customizations.set(
      name,
      section === undefined
        ? { ...entry, append: text }
        : section === "replace"
          ? { ...entry, replace: text }
          : { ...entry, sections: { ...entry.sections, [section]: text } },
    );
  }
  return customizations;
}

const SECTION = /^<(\w+)>\n[\s\S]*?\n<\/\1>$/gm;

/** Names of the top-level <section> blocks in a prompt, in order. */
export function promptSections(prompt: string): string[] {
  return [...prompt.matchAll(SECTION)].map((match) => match[1]!);
}

/**
 * The prompt's body after a project's replacement and section overrides,
 * without appended text. A section the prompt does not have is an error, for
 * the same reason as an unknown file name.
 */
export function customizeBody(
  prompt: string,
  customization: PromptCustomization | undefined,
  label = "The prompt",
): string {
  let body = customization?.replace ?? prompt;
  for (const [section, text] of Object.entries(customization?.sections ?? {})) {
    const block = /^\w+$/.test(section)
      ? new RegExp(`^(<${section}>\\n)[\\s\\S]*?(\\n</${section}>)$`, "m")
      : null;
    if (!block?.test(body)) {
      throw new Error(
        `${label} has no <${section}> section to replace. Its sections are: ${promptSections(body).join(", ")}.`,
      );
    }
    if (new RegExp(`^</${section}>$`, "m").test(text)) {
      throw new Error(
        `The replacement for <${section}> contains its own closing </${section}> line, which would end the section early.`,
      );
    }
    body = body.replace(
      block,
      (_, open: string, close: string) => `${open}${text}${close}`,
    );
  }
  return body;
}

/** Appends project text under its own heading, so the model can tell it apart from the built-in prompt. */
export function withAppended(
  prompt: string,
  append: string | undefined,
  heading = "Instructions from this project",
): string {
  return append ? `${prompt}\n\n## ${heading}\n\n${append}` : prompt;
}

export function applyCustomization(
  prompt: string,
  customization: PromptCustomization | undefined,
  heading?: string,
): string {
  return withAppended(
    customizeBody(prompt, customization),
    customization?.append,
    heading,
  );
}
