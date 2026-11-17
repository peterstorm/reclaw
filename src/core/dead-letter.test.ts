import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { NO_UNTRIAGED, rawScheduled } from './__fixtures__/dead-letter.js';
import {
  DLQ_USAGE,
  type RawFailedJob,
  classifyDeadLetter,
  formatClearReport,
  formatRetryReport,
  formatTriage,
  parseDlqCommand,
  planClear,
  planRetry,
  summarizeReason,
  triageDeadLetters,
} from './dead-letter.js';

const NOW = new Date('2026-11-17T10:00:00.000Z');
const FRESH = { triggeredAt: '2026-11-17T09:00:00.000Z', validUntil: '2026-11-17T12:00:00.000Z' };
const STALE = { triggeredAt: '2026-11-14T09:00:00.000Z', validUntil: '2026-11-14T10:00:00.000Z' };

const unreadable = (jobId: string): RawFailedJob => ({
  jobId,
  data: { kind: 'scheduled', id: jobId },
  failedReason: 'corrupt',
  finishedOn: undefined,
});

// ─── parseDlqCommand ──────────────────────────────────────────────────────────

describe('parseDlqCommand', () => {
  it.each([
    ['/dlq', 'list'],
    ['  /DLQ  ', 'list'],
    ['/dlq retry', 'retry'],
    ['/dlq   RETRY', 'retry'],
    ['/dlq clear', 'clear'],
  ])('parses %j as %s', (text, kind) => {
    expect(parseDlqCommand(text)).toEqual({ ok: true, value: { kind } });
  });

  it.each(['/dlq purge', '/dlq retry now', '/dlqretry', '/status'])(
    'rejects %j with the usage text',
    (text) => {
      expect(parseDlqCommand(text)).toEqual({ ok: false, error: DLQ_USAGE });
    },
  );
});

// ─── classifyDeadLetter ───────────────────────────────────────────────────────

describe('classifyDeadLetter', () => {
  it('is fresh inside [triggeredAt, validUntil], inclusive at both ends', () => {
    expect(classifyDeadLetter(rawScheduled('a', 's', FRESH), NOW).kind).toBe('fresh');
    expect(classifyDeadLetter(rawScheduled('a', 's', FRESH), new Date(FRESH.validUntil)).kind).toBe(
      'fresh',
    );
    expect(
      classifyDeadLetter(rawScheduled('a', 's', FRESH), new Date(FRESH.triggeredAt)).kind,
    ).toBe('fresh');
  });

  it('is stale after validUntil and before triggeredAt — the handler would discard either', () => {
    expect(classifyDeadLetter(rawScheduled('a', 's', STALE), NOW).kind).toBe('stale');
    expect(
      classifyDeadLetter(rawScheduled('a', 's', FRESH), new Date('2026-11-17T08:59:59.999Z')).kind,
    ).toBe('stale');
  });

  it('is unreadable when the job data does not parse, keeping the parse error', () => {
    const letter = classifyDeadLetter(unreadable('x'), NOW);
    expect(letter.kind).toBe('unreadable');
    expect(letter.kind === 'unreadable' && letter.parseError).toContain('Invalid scheduled job');
  });
});

// ─── triageDeadLetters ────────────────────────────────────────────────────────

describe('triageDeadLetters', () => {
  it('groups by skill, most failures first, ties by skill id', () => {
    const triage = triageDeadLetters(
      [
        rawScheduled('l1', 'learn-recall', STALE),
        rawScheduled('c1', 'curriculum-builder', STALE),
        rawScheduled('l2', 'learn-recall', FRESH),
        rawScheduled('b1', 'briefing', FRESH),
        unreadable('u1'),
      ],
      NOW,
    );
    expect(triage.skills.map((s) => [s.skillId, s.fresh.length, s.stale.length])).toEqual([
      ['learn-recall', 1, 1],
      ['briefing', 1, 0],
      ['curriculum-builder', 0, 1],
    ]);
    expect(triage.unreadable.map((u) => u.jobId)).toEqual(['u1']);
  });

  it('reports the most recent failure reason per skill, by finish time', () => {
    const triage = triageDeadLetters(
      [
        rawScheduled('a', 'garmin-sync', STALE, 'old 429', 1_000),
        rawScheduled('b', 'garmin-sync', STALE, 'new 403', 2_000),
        rawScheduled('c', 'garmin-sync', STALE, 'middle', 1_500),
      ],
      NOW,
    );
    expect(triage.skills[0]?.latestReason).toBe('new 403');
  });

  it('falls back to trigger time when the finish time is missing', () => {
    const triage = triageDeadLetters(
      [
        rawScheduled('a', 'garmin-sync', STALE, 'older trigger'),
        rawScheduled('b', 'garmin-sync', FRESH, 'newer trigger'),
      ],
      NOW,
    );
    expect(triage.skills[0]?.latestReason).toBe('newer trigger');
  });
});

// ─── Properties ───────────────────────────────────────────────────────────────

const BASE_MS = Date.parse('2026-11-01T00:00:00.000Z');
const HOUR = 3_600_000;

/** A failed job built through the same shape BullMQ stores; ~1 in 8 is corrupt. */
const rawJob = (jobId: string): fc.Arbitrary<RawFailedJob> =>
  fc.oneof(
    {
      weight: 7,
      arbitrary: fc
        .record({
          skill: fc.constantFrom('briefing', 'garmin-sync', 'learn-recall', 'tech-digest'),
          triggeredOffset: fc.integer({ min: 0, max: 30 * 24 * HOUR }),
          windowMs: fc.integer({ min: 60_000, max: 48 * HOUR }),
          finishedOn: fc.option(fc.integer({ min: BASE_MS, max: BASE_MS + 31 * 24 * HOUR }), {
            nil: undefined,
          }),
          reason: fc.string(),
        })
        .map(({ skill, triggeredOffset, windowMs, finishedOn, reason }) =>
          rawScheduled(
            jobId,
            skill,
            {
              triggeredAt: new Date(BASE_MS + triggeredOffset).toISOString(),
              validUntil: new Date(BASE_MS + triggeredOffset + windowMs).toISOString(),
            },
            reason,
            finishedOn,
          ),
        ),
    },
    { weight: 1, arbitrary: fc.constant(unreadable(jobId)) },
  );

const failedSet: fc.Arbitrary<readonly RawFailedJob[]> = fc
  .uniqueArray(fc.stringMatching(/^[a-z0-9:-]{1,24}$/), { maxLength: 30 })
  .chain((ids) => fc.tuple(...ids.map(rawJob)));

const nowArb = fc
  .integer({ min: BASE_MS, max: BASE_MS + 32 * 24 * HOUR })
  .map((ms) => new Date(ms));

describe('triage properties', () => {
  it('retry and clear plans partition the failed set exactly', () => {
    fc.assert(
      fc.property(failedSet, nowArb, (raws, now) => {
        const triage = triageDeadLetters(raws, now);
        const retry = planRetry(triage);
        const clear = planClear(triage);
        expect(new Set([...retry, ...clear]).size).toBe(retry.length + clear.length);
        expect([...retry, ...clear].sort()).toEqual(raws.map((r) => r.jobId).sort());
      }),
    );
  });

  it('never plans a retry for a job the scheduled handler would discard', () => {
    fc.assert(
      fc.property(failedSet, nowArb, (raws, now) => {
        const byId = new Map(raws.map((r) => [r.jobId, r.data]));
        for (const id of planRetry(triageDeadLetters(raws, now))) {
          const { triggeredAt, validUntil } = byId.get(id) as {
            triggeredAt: string;
            validUntil: string;
          };
          expect(now.getTime()).toBeGreaterThanOrEqual(Date.parse(triggeredAt));
          expect(now.getTime()).toBeLessThanOrEqual(Date.parse(validUntil));
        }
      }),
    );
  });

  it('does not depend on the order the queue lists failed jobs in', () => {
    fc.assert(
      fc.property(
        failedSet.chain((raws) =>
          fc.tuple(
            fc.constant(raws),
            fc.shuffledSubarray([...raws], {
              minLength: raws.length,
              maxLength: raws.length,
            }),
          ),
        ),
        nowArb,
        ([raws, shuffled], now) => {
          const a = triageDeadLetters(raws, now);
          const b = triageDeadLetters(shuffled, now);
          const shape = (t: typeof a) =>
            t.skills.map((s) => ({
              skillId: s.skillId,
              fresh: s.fresh.map((j) => j.id).sort(),
              stale: s.stale.map((j) => j.id).sort(),
            }));
          expect(shape(b)).toEqual(shape(a));
          expect(new Set(planRetry(b))).toEqual(new Set(planRetry(a)));
        },
      ),
    );
  });

  it('a job only ever moves fresh → stale as time passes, never back', () => {
    fc.assert(
      fc.property(
        failedSet,
        nowArb,
        fc.integer({ min: 0, max: 7 * 24 * HOUR }),
        (raws, now, dt) => {
          const later = new Date(now.getTime() + dt);
          const freshLater = new Set(planRetry(triageDeadLetters(raws, later)));
          const freshNow = new Set(planRetry(triageDeadLetters(raws, now)));
          // Anything fresh later was either fresh now or not yet triggered now.
          for (const id of freshLater) {
            const data = raws.find((r) => r.jobId === id)?.data as { triggeredAt: string };
            expect(freshNow.has(id) || Date.parse(data.triggeredAt) > now.getTime()).toBe(true);
          }
        },
      ),
    );
  });
});

// ─── Formatting ───────────────────────────────────────────────────────────────

describe('summarizeReason', () => {
  it('keeps the first line only and bounds its length', () => {
    expect(summarizeReason('429 Too Many Requests\n  at foo\n  at bar')).toBe(
      '429 Too Many Requests',
    );
    const long = summarizeReason('x'.repeat(500));
    expect(long).toHaveLength(120);
    expect(long.endsWith('…')).toBe(true);
  });

  it('names a missing reason instead of printing nothing', () => {
    expect(summarizeReason('  \n')).toBe('(no reason recorded)');
  });
});

describe('formatTriage', () => {
  it('says so when the failed set is empty, still naming other queues with failures', () => {
    const empty = triageDeadLetters([], NOW);
    expect(formatTriage(empty, NO_UNTRIAGED)).toBe('Dead-letter queue: no failed scheduled jobs.');
    expect(formatTriage(empty, { ...NO_UNTRIAGED, chat: 2, delivery: 1 })).toBe(
      'Dead-letter queue: no failed scheduled jobs.\nOther queues (failed, not triaged): chat 2, delivery 1',
    );
  });

  it('lists each skill with its split and last error, then only the actions that apply', () => {
    const triage = triageDeadLetters(
      [
        rawScheduled('a', 'learn-recall', STALE, 'pi 429: rate limited\nstack…'),
        rawScheduled('b', 'learn-recall', STALE, 'pi 429: rate limited'),
        unreadable('u'),
      ],
      NOW,
    );
    const text = formatTriage(triage, NO_UNTRIAGED);
    expect(text).toBe(
      [
        'Dead-letter queue: 0 fresh, 3 stale/unreadable',
        '',
        '• learn-recall — 0 fresh, 2 stale',
        '  last error: pi 429: rate limited',
        '• (unreadable job data) — 1',
        '',
        '/dlq clear — remove 3 stale/unreadable jobs',
      ].join('\n'),
    );
    expect(text).not.toContain('/dlq retry');
  });

  it('offers retry when a fresh job exists', () => {
    const triage = triageDeadLetters([rawScheduled('a', 'briefing', FRESH)], NOW);
    expect(formatTriage(triage, NO_UNTRIAGED)).toContain('/dlq retry — re-run 1 fresh job');
  });
});

describe('formatRetryReport / formatClearReport', () => {
  const triage = triageDeadLetters(
    [
      rawScheduled('f1', 'briefing', FRESH),
      rawScheduled('f2', 'briefing', FRESH),
      rawScheduled('f3', 'garmin-sync', FRESH),
      rawScheduled('s1', 'learn-recall', STALE),
    ],
    NOW,
  );

  it('reports retries grouped by skill, plus what was skipped as stale', () => {
    expect(
      formatRetryReport(triage, {
        done: ['f1', 'f2'],
        gone: ['f3'],
        failed: [],
      }),
    ).toBe(
      [
        'Retried 2 fresh jobs:',
        '• briefing × 2',
        '1 had already left the failed set.',
        'Skipped 1 stale/unreadable (/dlq clear removes them).',
      ].join('\n'),
    );
  });

  it('names a job whose retry failed', () => {
    expect(
      formatRetryReport(triage, { done: [], gone: [], failed: [{ jobId: 'f1', error: 'nope' }] }),
    ).toContain('Could not retry f1: nope');
  });

  it('says there is nothing to retry when nothing is fresh', () => {
    const staleOnly = triageDeadLetters([rawScheduled('s1', 'x', STALE)], NOW);
    expect(formatRetryReport(staleOnly, { done: [], gone: [], failed: [] })).toBe(
      'Nothing to retry: no fresh failed jobs.\nSkipped 1 stale/unreadable (/dlq clear removes them).',
    );
  });

  it('reports a clear and the fresh jobs it kept', () => {
    expect(formatClearReport(triage, { done: ['s1'], gone: [], failed: [] })).toBe(
      'Cleared 1 stale/unreadable job.\nKept 3 fresh (/dlq retry re-runs them).',
    );
  });

  it('says there is nothing to clear when nothing is stale', () => {
    const freshOnly = triageDeadLetters([rawScheduled('f', 'x', FRESH)], NOW);
    expect(formatClearReport(freshOnly, { done: [], gone: [], failed: [] })).toBe(
      'Nothing to clear: no stale or unreadable failed jobs.\nKept 1 fresh (/dlq retry re-runs them).',
    );
  });
});
