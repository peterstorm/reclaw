/**
 * Skill execution quality signals — pure formatting only.
 *
 * Appended as JSONL records to a durable log after a scheduled skill runs.
 * Anomalies-only (errors / suppressions / missing skills). Plain successes are
 * not recorded.
 *
 * These used to be written as *pinned cortex memories*, which forced ~40 lines of
 * carve-out logic in cortex-prune to keep the nightly pruner from eating the
 * skill-quality-monitor's input. Moving them to a dedicated JSONL file the pruner
 * never touches removes that cross-prompt invariant entirely and keeps the recall
 * surface free of operational noise.
 */

import type { SkillId } from './types.js';

// ─── Status ──────────────────────────────────────────────────────────────────

export type SkillRunStatus =
  | 'success'
  | 'suppressed'
  | 'claude_error'
  | 'skill_not_found'
  | 'validity_expired';

/**
 * The subset of statuses that warrant a persisted record. Narrowing to this
 * subtype lets the record type below make the impossible states (`success`,
 * `validity_expired`) unrepresentable rather than merely unreachable.
 */
export type AnomalyStatus = 'suppressed' | 'claude_error' | 'skill_not_found';

export type SkillQualitySignal = {
  readonly skillId: SkillId;
  readonly status: SkillRunStatus;
  readonly durationMs: number;
  readonly outputLength: number;
  readonly errorMessage: string | null;
  readonly timestamp: string;
};

// ─── Record shape (one JSONL line) ───────────────────────────────────────────

export type SkillQualityRecord = {
  readonly timestamp: string;
  readonly skillId: string;
  readonly status: AnomalyStatus;
  readonly durationMs: number;
  readonly outputLength: number;
  readonly errorMessage: string | null;
  readonly severity: 5 | 7 | 8; // 5 suppressed · 7 claude_error · 8 skill_not_found
  readonly summary: string; // human-readable one-liner for the weekly digest
};

// ─── Decision: which signals deserve a record ────────────────────────────────

/**
 * Anomalies-only policy. Successful runs and validity-window misses do not
 * produce records — they're high-volume operational noise. Typed as a guard so
 * callers narrow `SkillRunStatus` to `AnomalyStatus`.
 */
export function shouldRecord(status: SkillRunStatus): status is AnomalyStatus {
  return status === 'suppressed' || status === 'claude_error' || status === 'skill_not_found';
}

// ─── Formatting ──────────────────────────────────────────────────────────────

const SEVERITY_BY_STATUS: Record<AnomalyStatus, 5 | 7 | 8> = {
  suppressed: 5,
  claude_error: 7,
  skill_not_found: 8,
};

function describe(signal: SkillQualitySignal): string {
  const at = signal.timestamp;
  const id = signal.skillId;
  const ms = signal.durationMs;
  switch (signal.status) {
    case 'suppressed':
      return `${id} produced ALL_CLEAR (no output) at ${at} — duration ${ms}ms`;
    case 'claude_error': {
      const reason = signal.errorMessage ?? 'unknown error';
      return `${id} failed at ${at}: ${reason} — duration ${ms}ms`;
    }
    case 'skill_not_found':
      return `${id} scheduled but missing from registry at ${at}`;
    case 'success':
    case 'validity_expired':
      return `${id} ${signal.status} at ${at}`;
  }
}

/**
 * Build the JSONL record for a signal, or null if the signal doesn't warrant a
 * record under the anomalies-only policy.
 */
export function toRecord(signal: SkillQualitySignal): SkillQualityRecord | null {
  if (!shouldRecord(signal.status)) return null;
  return {
    timestamp: signal.timestamp,
    skillId: signal.skillId,
    status: signal.status,
    durationMs: signal.durationMs,
    outputLength: signal.outputLength,
    errorMessage: signal.errorMessage,
    severity: SEVERITY_BY_STATUS[signal.status],
    summary: describe(signal),
  };
}
