/**
 * Skill execution quality signals — pure formatting only.
 *
 * Emitted as cortex memories after a scheduled skill runs. Anomalies-only
 * (errors / suppressions / missing skills) so the recall surface stays clean
 * and per-run noise doesn't get pruned away. Plain successes are not recorded.
 */

import type { SkillId } from './types.js';

// ─── Status ──────────────────────────────────────────────────────────────────

export type SkillRunStatus =
  | 'success'
  | 'suppressed'
  | 'claude_error'
  | 'skill_not_found'
  | 'validity_expired';

export type SkillQualitySignal = {
  readonly skillId: SkillId;
  readonly status: SkillRunStatus;
  readonly durationMs: number;
  readonly outputLength: number;
  readonly errorMessage: string | null;
  readonly timestamp: string;
};

// ─── Memory shape ────────────────────────────────────────────────────────────

export type CortexMemoryType = 'pattern' | 'gotcha';

export type SkillQualityMemory = {
  readonly content: string;
  readonly type: CortexMemoryType;
  readonly priority: number;
  readonly tags: ReadonlyArray<string>;
};

// ─── Decision: which signals deserve a memory ────────────────────────────────

/**
 * Anomalies-only policy. Successful runs and validity-window misses do not
 * produce memories — they're high-volume operational noise that would either
 * pollute recall or get culled by the nightly prune.
 */
export function shouldRecord(status: SkillRunStatus): boolean {
  return status === 'suppressed' || status === 'claude_error' || status === 'skill_not_found';
}

// ─── Formatting ──────────────────────────────────────────────────────────────

const TYPE_BY_STATUS: Record<SkillRunStatus, CortexMemoryType | null> = {
  success: null,
  validity_expired: null,
  suppressed: 'pattern',
  claude_error: 'gotcha',
  skill_not_found: 'gotcha',
};

const PRIORITY_BY_STATUS: Record<SkillRunStatus, number> = {
  success: 0,
  validity_expired: 0,
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
      return `skill-quality ${id} produced ALL_CLEAR (no output) at ${at} — duration ${ms}ms`;
    case 'claude_error': {
      const reason = signal.errorMessage ?? 'unknown error';
      return `skill-quality ${id} failed at ${at}: ${reason} — duration ${ms}ms`;
    }
    case 'skill_not_found':
      return `skill-quality ${id} scheduled but missing from registry at ${at}`;
    case 'success':
    case 'validity_expired':
      return `skill-quality ${id} ${signal.status} at ${at}`;
  }
}

/**
 * Build the cortex memory payload for a signal, or null if the signal
 * doesn't warrant a memory under the anomalies-only policy.
 */
export function toMemory(signal: SkillQualitySignal): SkillQualityMemory | null {
  if (!shouldRecord(signal.status)) return null;
  const type = TYPE_BY_STATUS[signal.status];
  if (type === null) return null;
  return {
    content: describe(signal),
    type,
    priority: PRIORITY_BY_STATUS[signal.status],
    tags: ['skill-quality', signal.skillId, signal.status],
  };
}
