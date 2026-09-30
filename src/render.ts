import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

/**
 * Renders the stream as a delegation trace: which specialist was invoked, what
 * tools ran, and what the manager concluded. Subagent internals stay collapsed
 * so the operator can follow the shape of the work without reading transcripts.
 */
export function createRenderer(opts: { verbose: boolean }) {
  return function render(message: SDKMessage): void {
    switch (message.type) {
      case "system": {
        if (message.subtype === "init") {
          console.log(
            `${DIM}session ${message.session_id}  model ${message.model}  agents: ${message.agents?.length ?? 0}${RESET}\n`,
          );
        }
        return;
      }

      case "assistant": {
        for (const block of message.message.content) {
          if (block.type === "text" && block.text.trim()) {
            console.log(`${block.text}\n`);
          } else if (block.type === "tool_use") {
            console.log(
              `${CYAN}▸ ${block.name}${RESET} ${DIM}${describe(block.name, block.input)}${RESET}`,
            );
          }
        }
        return;
      }

      case "user": {
        if (!opts.verbose) return;
        const content = message.message.content;
        if (typeof content === "string") return;
        for (const block of content) {
          if (block.type === "tool_result") {
            const text =
              typeof block.content === "string"
                ? block.content
                : (block.content ?? [])
                    .map((c) => ("text" in c ? c.text : ""))
                    .join("");
            console.log(`${DIM}  ← ${truncate(text, 400)}${RESET}`);
          }
        }
        return;
      }

      case "result": {
        const tint = message.is_error ? RED : BOLD;
        console.log(
          `\n${tint}── ${message.is_error ? "failed" : "complete"}${RESET} ${DIM}${message.num_turns} turns · ${(message.duration_ms / 1000).toFixed(1)}s${
            message.total_cost_usd === undefined
              ? ""
              : ` · $${message.total_cost_usd.toFixed(4)}`
          }${RESET}`,
        );
        return;
      }

      default:
        return;
    }
  };
}

function describe(tool: string, input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const record = input as Record<string, unknown>;

  if (tool === "Agent") {
    const type = str(record.subagent_type) || "general-purpose";
    return `→ ${YELLOW}${type}${RESET}${DIM}  ${truncate(str(record.description), 60)}`;
  }
  if (tool === "Bash") return truncate(str(record.command), 100);
  if (tool === "TodoWrite")
    return `${(record.todos as unknown[] | undefined)?.length ?? 0} items`;

  const path =
    str(record.file_path) ||
    str(record.path) ||
    str(record.pattern) ||
    str(record.url);
  return truncate(path, 100);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function truncate(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
