/**
 * Fire-and-forget recorder for skill execution quality signals.
 *
 * Appends one JSON line per anomalous scheduled run to a durable JSONL log
 * (default `~/.cache/reclaw/skill-quality.jsonl`). The skill-quality-monitor
 * reads this file for its weekly triage. Errors are logged but never propagated —
 * quality tracking must never block or fail a scheduled job.
 *
 * This replaces the previous cortex-memory recorder: writing to a dedicated file
 * (that cortex-prune never touches) removes the fragile carve-out the pruner
 * needed to avoid eating the monitor's input, and keeps the recall surface clean.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { toRecord, type SkillQualitySignal } from '../core/skill-quality.js';

export type SkillQualityRecorder = (signal: SkillQualitySignal) => void;

/**
 * Create a recorder bound to a JSONL log path.
 *
 * The recorder filters signals through `toRecord` (anomalies-only policy);
 * non-recordable signals are silently dropped without touching the disk.
 */
export function createSkillQualityRecorder(logPath: string): SkillQualityRecorder {
  return (signal: SkillQualitySignal): void => {
    const record = toRecord(signal);
    if (record === null) return;

    void (async () => {
      // Ensure the parent dir exists (idempotent), then append a single line.
      // The scheduled queue runs at concurrency 1, so appends never interleave.
      await mkdir(dirname(logPath), { recursive: true });
      await appendFile(logPath, `${JSON.stringify(record)}\n`, 'utf8');
    })().catch((err: unknown) => {
      console.error(
        `[skill-quality] failed to append record for skill=${signal.skillId} status=${signal.status}: ${err}`,
      );
    });
  };
}
