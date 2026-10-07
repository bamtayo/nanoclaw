/**
 * Structural guard against routing bulk email HTML through the model's context.
 *
 * Background (2026-07-10): an agent sending 40 KPI emails read each rendered
 * body into a tool result and echoed it straight back as the `htmlBody`
 * argument of `send_email` — ~16k tokens per recipient. It exhausted the
 * context window after ~8 sends, then spent 149 consecutive compactions unable
 * to make progress, wedging the session for hours.
 *
 * Prompt-level rules did not survive: a newly created scheduled task inherits
 * no instructions, and CLAUDE.md guidance is advisory. This enforces the rule
 * at the point of harm instead, so it holds for every agent, every task, and
 * every ad-hoc request, whether or not anyone remembered to say so.
 *
 * One limit, mirroring the operator rule "more than 3 emails must go through a
 * script":
 *
 *   Rate — more than MAX_HTML_SENDS inline bodies inside SEND_WINDOW_MS.
 *
 * The rate limit is what actually catches a bulk loop, and it is the ONLY axis
 * we gate on. An earlier version also blocked any single inline body over 10KB,
 * but that was wrong: legitimate one-off rich emails (the EV newsletter, daily
 * summaries, performance rankings) are routinely 20–60KB of inline HTML sent
 * one at a time, and a single such send costs ~6k tokens ONCE — harmless. The
 * death spiral only comes from repetition, so size alone is not a signal (the
 * 2026-07-10 bodies were only ~6.8KB each and a size check would have missed
 * them entirely while false-positiving on every normal newsletter). Gate on
 * count, not size. (Adetayo, 2026-07-11 — after the size gate blocked a 23KB
 * EV roundup: "keep it at >3 emails".)
 *
 * The window is sliding rather than a process-wide counter because one
 * container serves many scheduled tasks over hours — three summary emails at
 * 08:00 and three more at 14:00 are legitimate and must not be blocked.
 *
 * Plain-text sends are never counted or blocked; only inline HTML is.
 * The escape hatch is `send_batch.mjs`, which reads HTML off disk and calls the
 * Gmail API from Bash, so the bytes never enter the context at all.
 */

/** A single inline-HTML send that has already been permitted, by epoch ms. */
export type SendAttempt = number;

export const MAX_HTML_SENDS = 5;
export const SEND_WINDOW_MS = 10 * 60 * 1000;

export interface SendVerdict {
  /** Block the tool call outright. */
  block: boolean;
  /** Shown to the model when blocked. */
  reason?: string;
  /** Whether this attempt should be recorded against the rate limit. */
  record: boolean;
}

const ALLOWED: SendVerdict = { block: false, record: false };

/** Matches `send_email` and MCP-namespaced variants like `mcp__gmail__send_email`. */
function isEmailSend(toolName: string): boolean {
  return /(^|__)send_email$/.test(toolName);
}

const USE_SCRIPT =
  'STOP sending inline and switch to the bulk sender NOW. Do NOT stop to ask ' +
  'anyone for approval and do NOT abandon the run — the script is the sanctioned ' +
  'path for a batch and needs no approval. Render the remaining recipients to a ' +
  'records JSON ({to, subject, html} per recipient) with a script, then run ' +
  '`node send_batch.mjs --file <records>.json` (check it first with --dry-run). ' +
  'It reads the HTML off disk, so it never enters your context, and its send log ' +
  'skips anyone already emailed so re-running is safe. ' +
  'Never print rendered HTML into a tool result.';

/**
 * Decide whether an outgoing tool call should be blocked.
 *
 * Pure: `recent` is the caller's window of previously-permitted inline-HTML
 * sends. The caller prunes and appends based on the returned verdict.
 */
export function evaluateSend(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  now: number,
  recent: readonly SendAttempt[],
): SendVerdict {
  if (!isEmailSend(toolName)) return ALLOWED;

  const htmlBody = toolInput?.htmlBody;
  if (typeof htmlBody !== 'string' || htmlBody.length === 0) return ALLOWED;

  // Size is deliberately NOT a gate — see the header comment. A single rich
  // email is fine; only a burst of them wedges the context. Gate on rate only.
  const inWindow = recent.filter((t) => now - t < SEND_WINDOW_MS);
  if (inWindow.length >= MAX_HTML_SENDS) {
    // record: true even though blocked — counting the *attempt* keeps the
    // window hot, so an agent that keeps hammering never drains it one slot at
    // a time. A continuous burst is hard-capped at MAX_HTML_SENDS; the window
    // only reopens after a genuine SEND_WINDOW_MS of quiet.
    return {
      block: true,
      record: true,
      reason:
        `Refusing to send: ${inWindow.length} HTML emails already sent inline in the last ` +
        `${SEND_WINDOW_MS / 60000} minutes. Sending a batch one call at a time fills the context ` +
        `window and wedges the session. ${USE_SCRIPT}`,
    };
  }

  return { block: false, record: true };
}

/** Drop attempts that have aged out of the window. */
export function pruneAttempts(recent: SendAttempt[], now: number): SendAttempt[] {
  return recent.filter((t) => now - t < SEND_WINDOW_MS);
}
