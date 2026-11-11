import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export interface Summary {
  result: string;
  isError: boolean;
  turns: number;
  durationMs: number;
  costUsd?: number;
  sessionId?: string;
  /** Whether any result message arrived; a run without one did not finish. */
  received: boolean;
}

export const EMPTY_SUMMARY: Readonly<Summary> = Object.freeze({
  result: "",
  isError: false,
  turns: 0,
  durationMs: 0,
  received: false,
});

/**
 * Folds one stream message into the run summary. A query can emit more than
 * one result message; the latest carries the cumulative totals, but an error
 * in any of them must not be hidden by a later success.
 */
export function foldMessage(summary: Summary, message: SDKMessage): Summary {
  // Known from the first message, so a run that crashes can still be resumed.
  const sessionId = summary.sessionId ?? message.session_id;
  if (message.type !== "result") {
    return sessionId === undefined ? summary : { ...summary, sessionId };
  }
  // A failed result's errors carry the cause (a bad --resume id, an auth or
  // startup failure); the subtype alone does not.
  const text =
    message.subtype === "success"
      ? message.result
      : [`Run ended: ${message.subtype}`, ...(message.errors ?? [])].join("\n");
  const costUsd = message.total_cost_usd ?? summary.costUsd;
  return {
    // An earlier failure's explanation survives a later successful result.
    result:
      summary.isError && !message.is_error && summary.result
        ? `${summary.result}\n\n${text}`
        : text,
    isError: summary.isError || message.is_error,
    turns: message.num_turns,
    durationMs: message.duration_ms,
    ...(costUsd === undefined ? {} : { costUsd }),
    sessionId: message.session_id,
    received: true,
  };
}

/**
 * Called once the stream has ended. A stream that ends without any result
 * message did not finish, and must not be reported as a success.
 */
export function finishSummary(summary: Summary): Summary {
  if (summary.received || summary.isError) return summary;
  return {
    ...summary,
    isError: true,
    result: "The run ended without a result; it may not have finished.",
  };
}

/** A stream that throws keeps whatever result it already produced. */
export function foldFailure(summary: Summary, error: unknown): Summary {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    ...summary,
    isError: true,
    result: summary.result
      ? `${summary.result}\n\nThe run then failed: ${reason}`
      : `Run failed: ${reason}`,
  };
}
