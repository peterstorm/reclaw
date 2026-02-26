import { parseExpression } from 'cron-parser';
import { type Result, err, ok } from './types.js';

// ─── Schedule ─────────────────────────────────────────────────────────────────
//
// FR-023: Retry missed scheduled execution if within validity window.
//
// Pure functions — no I/O, no side effects.

/**
 * Return true if `now` is within the validity window starting at `triggeredAt`.
 *
 * A job triggered at T with a window of N minutes is valid until T + N minutes.
 * now must be >= triggeredAt and <= triggeredAt + validityMinutes.
 */
export function isWithinValidityWindow(
  triggeredAt: Date,
  validityMinutes: number,
  now: Date,
): boolean {
  const t = triggeredAt.getTime();
  const nowMs = now.getTime();
  const validUntilMs = t + validityMinutes * 60 * 1000;
  return nowMs >= t && nowMs <= validUntilMs;
}

/**
 * Return the next run Date for a cron expression as a Result.
 *
 * `after` is required — callers pass `new Date()` at the shell boundary.
 * Returns err if the cron expression is invalid.
 */
export function getNextRun(cronExpression: string, after: Date): Result<Date, string> {
  try {
    const interval = parseExpression(cronExpression, { currentDate: after });
    return ok(interval.next().toDate());
  } catch (e) {
    return err(`Invalid cron "${cronExpression}": ${e instanceof Error ? e.message : String(e)}`);
  }
}
