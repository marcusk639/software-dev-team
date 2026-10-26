import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export interface Summary {
  result: string;
  isError: boolean;
  turns: number;
  durationMs: number;
  costUsd?: number;
  sessionId?: string;
}

export const EMPTY_SUMMARY: Summary = {
  result: "",
  isError: false,
  turns: 0,
  durationMs: 0,
};

/**
 * Folds one stream message into the run summary. A query can emit several
 * results (one per turn the manager takes, for example after a delegation
 * finishes); the latest carries the cumulative totals, but an error in any of
 * them must not be hidden by a later success.
 */
export function foldMessage(summary: Summary, message: SDKMessage): Summary {
  // Known from the first message, so a run that crashes can still be resumed.
  const sessionId = summary.sessionId ?? message.session_id;
  if (message.type !== "result") {
    return sessionId === undefined ? summary : { ...summary, sessionId };
  }
  const text =
    message.subtype === "success"
      ? message.result
      : `Run ended: ${message.subtype}`;
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
