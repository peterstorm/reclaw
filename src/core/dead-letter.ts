// ─── Dead-Letter Triage ───────────────────────────────────────────────────────
//
// Pure core behind `/dlq`. A scheduled job that exhausted its retries sits in the
// scheduled queue's failed set. Whether retrying it is worth anything depends on
// one thing: is it still inside its validity window? The scheduled handler
// discards any job processed outside [triggeredAt, validUntil], so retrying a
// stale job only produces a silent no-op. Triage therefore splits the failed set
// into three kinds:
//
//   fresh      — inside its window: a retry would actually run the skill
//   stale      — window passed: a retry is pointless; safe to clear
//   unreadable — job data no longer parses: cannot be retried; safe to clear
//
// The shell loads raw failed jobs through `DeadLetterStore`, this module triages
// them and decides what `/dlq retry` and `/dlq clear` touch, and the shell
// applies that plan job by job.

import { parseScheduledJob } from './job-schemas.js';
import type { JobId, Result, ScheduledJob, SkillId } from './types.js';
import { err, ok } from './types.js';

// ─── Command ──────────────────────────────────────────────────────────────────

export type DlqCommand =
  | { readonly kind: 'list' }
  | { readonly kind: 'retry' }
  | { readonly kind: 'clear' };

export const DLQ_USAGE = [
  'Usage:',
  '/dlq — Triage failed scheduled jobs (fresh vs stale, grouped by skill)',
  '/dlq retry — Retry every fresh failed job',
  '/dlq clear — Remove every stale or unreadable failed job',
].join('\n');

/** Parse `/dlq [retry|clear]`. Anything else is an error carrying the usage text. */
export function parseDlqCommand(text: string): Result<DlqCommand, string> {
  const [head, ...rest] = text.trim().split(/\s+/);
  if (head?.toLowerCase() !== '/dlq' || rest.length > 1) return err(DLQ_USAGE);
  const action = rest[0]?.toLowerCase();
  if (action === undefined) return ok({ kind: 'list' });
  if (action === 'retry') return ok({ kind: 'retry' });
  if (action === 'clear') return ok({ kind: 'clear' });
  return err(DLQ_USAGE);
}

// ─── Port ─────────────────────────────────────────────────────────────────────

/** A failed job as the queue stores it. `data` is wire data and is parsed here. */
export type RawFailedJob = {
  readonly jobId: string;
  readonly data: unknown;
  readonly failedReason: string;
  /** Epoch ms of the final failure; undefined when the queue did not record it. */
  readonly finishedOn: number | undefined;
};

/** Per-job result of a retry or removal. `gone` = no longer in the failed set. */
export type DeadLetterActionOutcome = 'done' | 'gone';

/** Queues whose failed jobs `/dlq` counts but does not triage. */
export const UNTRIAGED_QUEUES = ['chat', 'reminder', 'research', 'podcast', 'delivery'] as const;
export type UntriagedQueue = (typeof UNTRIAGED_QUEUES)[number];
export type UntriagedFailedCounts = Readonly<Record<UntriagedQueue, number>>;

/** Dead-letter port over the scheduled queue's failed set. */
export type DeadLetterStore = {
  readonly listFailed: () => Promise<readonly RawFailedJob[]>;
  readonly retry: (jobId: string) => Promise<DeadLetterActionOutcome>;
  readonly remove: (jobId: string) => Promise<DeadLetterActionOutcome>;
  readonly untriagedFailedCounts: () => Promise<UntriagedFailedCounts>;
};

// ─── Triage ───────────────────────────────────────────────────────────────────

type FailureFacts = {
  readonly failedReason: string;
  readonly finishedOn: number | undefined;
};

type ReadableDeadLetter = {
  readonly kind: 'fresh' | 'stale';
  readonly job: ScheduledJob;
} & FailureFacts;

type UnreadableDeadLetter = {
  readonly kind: 'unreadable';
  readonly jobId: string;
  readonly parseError: string;
} & FailureFacts;

export type DeadLetter = ReadableDeadLetter | UnreadableDeadLetter;

export type SkillDeadLetters = {
  readonly skillId: SkillId;
  readonly fresh: readonly ScheduledJob[];
  readonly stale: readonly ScheduledJob[];
  /** Failure reason of this skill's most recent failure. */
  readonly latestReason: string;
};

export type DeadLetterTriage = {
  /** Skills with at least one failed job, most failures first, then by id. */
  readonly skills: readonly SkillDeadLetters[];
  readonly unreadable: readonly UnreadableDeadLetter[];
};

/** Same window the scheduled handler enforces: triggeredAt <= now <= validUntil. */
function isFresh(job: ScheduledJob, now: Date): boolean {
  const nowMs = now.getTime();
  return nowMs >= Date.parse(job.triggeredAt) && nowMs <= Date.parse(job.validUntil);
}

export function classifyDeadLetter(raw: RawFailedJob, now: Date): DeadLetter {
  const facts: FailureFacts = { failedReason: raw.failedReason, finishedOn: raw.finishedOn };
  const parsed = parseScheduledJob(raw.data);
  if (!parsed.ok) {
    return { kind: 'unreadable', jobId: raw.jobId, parseError: parsed.error, ...facts };
  }
  return { kind: isFresh(parsed.value, now) ? 'fresh' : 'stale', job: parsed.value, ...facts };
}

/** Recency for "latest reason": the recorded failure time, else the trigger time. */
function recencyOf(letter: ReadableDeadLetter): number {
  return letter.finishedOn ?? Date.parse(letter.job.triggeredAt);
}

function groupForSkill(skillId: SkillId, group: readonly ReadableDeadLetter[]): SkillDeadLetters {
  const latest = group.reduce((a, b) => (recencyOf(b) > recencyOf(a) ? b : a));
  return {
    skillId,
    fresh: group.filter((l) => l.kind === 'fresh').map((l) => l.job),
    stale: group.filter((l) => l.kind === 'stale').map((l) => l.job),
    latestReason: latest.failedReason,
  };
}

const failureCount = (s: SkillDeadLetters): number => s.fresh.length + s.stale.length;

export function triageDeadLetters(raws: readonly RawFailedJob[], now: Date): DeadLetterTriage {
  const letters = raws.map((raw) => classifyDeadLetter(raw, now));
  const readable = letters.filter((l): l is ReadableDeadLetter => l.kind !== 'unreadable');
  const unreadable = letters.filter((l): l is UnreadableDeadLetter => l.kind === 'unreadable');

  const bySkill = Map.groupBy(readable, (l) => l.job.skillId);
  const skills = [...bySkill]
    .map(([skillId, group]) => groupForSkill(skillId, group))
    .sort((a, b) => failureCount(b) - failureCount(a) || a.skillId.localeCompare(b.skillId));

  return { skills, unreadable };
}

// ─── Plans ────────────────────────────────────────────────────────────────────

/** Job ids `/dlq retry` re-queues: every fresh job, and nothing else. */
export function planRetry(triage: DeadLetterTriage): readonly JobId[] {
  return triage.skills.flatMap((s) => s.fresh.map((job) => job.id));
}

/** Job ids `/dlq clear` removes: every stale or unreadable job, never a fresh one. */
export function planClear(triage: DeadLetterTriage): readonly string[] {
  return [
    ...triage.skills.flatMap((s) => s.stale.map((job) => job.id)),
    ...triage.unreadable.map((u) => u.jobId),
  ];
}

// ─── Formatting ───────────────────────────────────────────────────────────────

const REASON_MAX_CHARS = 120;

/** First line of a failure reason, bounded so one stack trace cannot flood the reply. */
export function summarizeReason(reason: string): string {
  const firstLine = reason.trim().split(/\r?\n/, 1)[0] ?? '';
  if (firstLine.length === 0) return '(no reason recorded)';
  return firstLine.length > REASON_MAX_CHARS
    ? `${firstLine.slice(0, REASON_MAX_CHARS - 1)}…`
    : firstLine;
}

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

function formatUntriaged(counts: UntriagedFailedCounts): readonly string[] {
  const nonZero = UNTRIAGED_QUEUES.filter((q) => counts[q] > 0);
  if (nonZero.length === 0) return [];
  return [
    `Other queues (failed, not triaged): ${nonZero.map((q) => `${q} ${counts[q]}`).join(', ')}`,
  ];
}

export function formatTriage(triage: DeadLetterTriage, untriaged: UntriagedFailedCounts): string {
  const otherLines = formatUntriaged(untriaged);
  const fresh = planRetry(triage).length;
  const clearable = planClear(triage).length;

  if (fresh + clearable === 0) {
    return ['Dead-letter queue: no failed scheduled jobs.', ...otherLines].join('\n');
  }

  const skillLines = triage.skills.flatMap((s) => [
    `• ${s.skillId} — ${s.fresh.length} fresh, ${s.stale.length} stale`,
    `  last error: ${summarizeReason(s.latestReason)}`,
  ]);
  const unreadableLines =
    triage.unreadable.length > 0 ? [`• (unreadable job data) — ${triage.unreadable.length}`] : [];
  const actions = [
    ...(fresh > 0 ? [`/dlq retry — re-run ${plural(fresh, 'fresh job')}`] : []),
    ...(clearable > 0 ? [`/dlq clear — remove ${plural(clearable, 'stale/unreadable job')}`] : []),
  ];

  return [
    `Dead-letter queue: ${fresh} fresh, ${clearable} stale/unreadable`,
    '',
    ...skillLines,
    ...unreadableLines,
    ...(otherLines.length > 0 ? ['', ...otherLines] : []),
    '',
    ...actions,
  ].join('\n');
}

/** What happened to each planned job id when the shell applied a plan. */
export type ActionReport = {
  readonly done: readonly string[];
  readonly gone: readonly string[];
  readonly failed: readonly { readonly jobId: string; readonly error: string }[];
};

/** Per-skill counts of the retried jobs, so the report reads by skill, not by job id. */
function retriedBySkill(triage: DeadLetterTriage, retried: readonly string[]): readonly string[] {
  const done = new Set(retried);
  return triage.skills.flatMap((s) => {
    const n = s.fresh.filter((job) => done.has(job.id)).length;
    return n > 0 ? [`• ${s.skillId} × ${n}`] : [];
  });
}

function failureLines(verb: string, report: ActionReport): readonly string[] {
  return report.failed.map((f) => `Could not ${verb} ${f.jobId}: ${summarizeReason(f.error)}`);
}

export function formatRetryReport(triage: DeadLetterTriage, report: ActionReport): string {
  const skipped = planClear(triage).length;
  const skippedLine =
    skipped > 0 ? [`Skipped ${skipped} stale/unreadable (/dlq clear removes them).`] : [];
  if (planRetry(triage).length === 0) {
    return ['Nothing to retry: no fresh failed jobs.', ...skippedLine].join('\n');
  }
  return [
    `Retried ${plural(report.done.length, 'fresh job')}:`,
    ...retriedBySkill(triage, report.done),
    ...(report.gone.length > 0 ? [`${report.gone.length} had already left the failed set.`] : []),
    ...failureLines('retry', report),
    ...skippedLine,
  ].join('\n');
}

export function formatClearReport(triage: DeadLetterTriage, report: ActionReport): string {
  const kept = planRetry(triage).length;
  const keptLine = kept > 0 ? [`Kept ${kept} fresh (/dlq retry re-runs them).`] : [];
  if (planClear(triage).length === 0) {
    return ['Nothing to clear: no stale or unreadable failed jobs.', ...keptLine].join('\n');
  }
  return [
    `Cleared ${plural(report.done.length, 'stale/unreadable job')}.`,
    ...(report.gone.length > 0 ? [`${report.gone.length} had already left the failed set.`] : []),
    ...failureLines('remove', report),
    ...keptLine,
  ].join('\n');
}
