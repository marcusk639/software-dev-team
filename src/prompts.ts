import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
