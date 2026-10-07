/**
 * Is a failed turn worth retrying later, or is it the agent's final answer?
 *
 * WHY THIS EXISTS (2026-09-02, Adetayo): a turn that never reached the API used to
 * finish exactly like a successful one. `runPollLoop` called `markCompleted` outside
 * its own catch, the host advanced the recurrence, and the occurrence vanished with
 * no trace beyond a log line. On 2026-09-01 an API outage between 13:01Z and 13:46Z
 * silently swallowed BOTH tasks due at 14:00 WAT — the Growth Performance Daily
 * Tracker and the HQ Managers Daily KPI Summary. Neither produced a file, neither
 * sent, both were marked completed, and nobody found out until the next day.
 *
 * The distinction that matters is not "did the turn error" but "could running it
 * again produce the report". A connectivity failure is worth retrying; a context
 * overflow, a bad credential or an exhausted quota will fail identically forever and
 * must be allowed to finish so the schedule moves on.
 */

/** Transport-level failures: the request never got an answer from the model. */
const RETRYABLE = [
  /unable to connect/i,
  /certificate_verification|certificate verify|self.signed certificate|unable to get local issuer/i,
  /\b(econnrefused|econnreset|enotfound|etimedout|ehostunreach|enetunreach|eai_again|epipe)\b/i,
  /socket hang up|network error|fetch failed|request timed out|\btimeout\b/i,
  /\b(500|502|503|504|529)\b/,
  /internal server error|bad gateway|service unavailable|gateway timeout|overloaded/i,
  /connection (closed|error|reset)/i,
];

/**
 * Failures that will repeat no matter how long we wait. Checked FIRST, because
 * some of these carry wording that would otherwise trip a pattern above — a quota
 * message naming a 503, say. Retrying these would hold a slot open for hours and
 * still fail, which is worse than failing now.
 */
const TERMINAL = [
  /prompt is too long|context.{0,20}(window|length|overflow)|too many tokens/i,
  /\b(401|403)\b|unauthorized|forbidden|invalid[_ ]api[_ ]key|authentication|invalid[_ ]grant/i,
  /quota|rate.?limit|billing|insufficient balance|credit balance/i,
  /\b(400|404|422)\b|invalid[_ ]request|not[_ ]found/i,
];

export function isRetryableFailure(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err ?? '');
  if (!msg) return false;
  if (TERMINAL.some((re) => re.test(msg))) return false;
  return RETRYABLE.some((re) => re.test(msg));
}
