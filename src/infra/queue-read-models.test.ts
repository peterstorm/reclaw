import type { JobSchedulerJson } from 'bullmq';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { formatDuration, formatReminderList } from '../core/reminder.js';
import {
  type RecurringSchedule,
  type RecurringScheduleSpec,
  makeRecurringSchedule,
} from '../core/types.js';
import {
  UNKNOWN_ACTIVE_RESEARCH,
  listedSchedule,
  parseActiveResearch,
  readReminderScheduler,
} from './queue-read-models.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const reminderData = {
  kind: 'recurring-reminder',
  id: 'job-004',
  chatId: 123,
  text: 'stand up',
  createdAt: '2026-03-29T10:00:00Z',
  intervalMs: 3600000,
  schedulerId: 'sched-001',
};

const scheduler = (
  overrides: Partial<JobSchedulerJson<unknown>> = {},
): JobSchedulerJson<unknown> => ({
  key: 'sched-001',
  name: 'sched-001',
  id: 'sched-001',
  template: { data: reminderData },
  ...overrides,
});

const researchData = {
  prompt: 'Research quantum computing advancements',
  sourceHints: ['https://arxiv.org'],
  chatId: 123,
  state: { kind: 'querying' },
  context: { topic: 'quantum', prompt: 'p', topicSlug: null, startedAt: '2026-03-29T10:00:00Z' },
};

// ─── readReminderScheduler ────────────────────────────────────────────────────

describe('readReminderScheduler', () => {
  it('reads an interval scheduler as a reminder', () => {
    expect(readReminderScheduler(scheduler({ every: 3600000 }))).toEqual({
      kind: 'reminder',
      info: {
        schedulerId: 'sched-001',
        text: 'stand up',
        schedule: { kind: 'interval', intervalMs: 3600000 },
        chatId: 123,
      },
    });
  });

  it('reads an interval template on a cron scheduler by the scheduler pattern', () => {
    const reading = readReminderScheduler(scheduler({ pattern: '0 12 * * 0' }));
    expect(reading).toEqual({
      kind: 'reminder',
      info: {
        schedulerId: 'sched-001',
        text: 'stand up',
        schedule: { kind: 'pattern', cronPattern: '0 12 * * 0' },
        chatId: 123,
      },
    });
  });

  it('prefers the template cron pattern and carries its description', () => {
    const reading = readReminderScheduler(
      scheduler({
        pattern: '0 9 * * *',
        template: {
          data: {
            ...reminderData,
            intervalMs: 0,
            cronPattern: '0 12 * * 0',
            cronDescription: 'every Sunday',
          },
        },
      }),
    );
    expect(reading).toMatchObject({
      kind: 'reminder',
      info: {
        schedule: { kind: 'cron', cronPattern: '0 12 * * 0', cronDescription: 'every Sunday' },
      },
    });
  });

  it('skips a scheduler with neither interval nor pattern', () => {
    expect(readReminderScheduler(scheduler())).toEqual({ kind: 'not-recurring' });
  });

  it('skips a scheduler without an id', () => {
    expect(readReminderScheduler(scheduler({ every: 3600000, id: null }))).toEqual({
      kind: 'not-recurring',
    });
  });

  it('reports unparseable template data instead of fabricating a reminder', () => {
    const reading = readReminderScheduler(
      scheduler({ every: 3600000, template: { data: { text: 'x' } } }),
    );
    expect(reading).toMatchObject({ kind: 'unparseable', schedulerId: 'sched-001' });
  });
});

// ─── listedSchedule ───────────────────────────────────────────────────────────

describe('listedSchedule', () => {
  const schedule = (spec: RecurringScheduleSpec): RecurringSchedule => {
    const made = makeRecurringSchedule(spec);
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  const hourly = schedule({ kind: 'interval', intervalMs: 3_600_000 });
  const sundays = schedule({
    kind: 'cron',
    cronPattern: '0 12 * * 0',
    cronDescription: 'every Sunday',
  });
  const SUNDAYS_LISTED = {
    kind: 'cron',
    cronPattern: '0 12 * * 0',
    cronDescription: 'every Sunday',
  } as const;

  it('lists an interval schedule the scheduler agrees with by its interval', () => {
    expect(listedSchedule(hourly, { every: 3_600_000 })).toEqual({
      kind: 'interval',
      intervalMs: 3_600_000,
    });
  });

  it('lists a cron template as itself, whatever the scheduler repeats on', () => {
    expect(listedSchedule(sundays, { pattern: '0 12 * * 0' })).toEqual(SUNDAYS_LISTED);
    expect(listedSchedule(sundays, { pattern: '0 9 * * *' })).toEqual(SUNDAYS_LISTED);
    expect(listedSchedule(sundays, { every: 7_200_000 })).toEqual(SUNDAYS_LISTED);
  });

  it('takes the interval from the scheduler, which is what BullMQ fires on', () => {
    expect(listedSchedule(hourly, { every: 7_200_000 })).toEqual({
      kind: 'interval',
      intervalMs: 7_200_000,
    });
  });

  it('lists an interval of 0 when the scheduler reports neither interval nor pattern', () => {
    expect(listedSchedule(hourly, {})).toEqual({ kind: 'interval', intervalMs: 0 });
  });

  it('lists an interval template by the scheduler pattern when it has a non-empty one', () => {
    expect(listedSchedule(hourly, { every: 3_600_000, pattern: '0 9 * * *' })).toEqual({
      kind: 'pattern',
      cronPattern: '0 9 * * *',
    });
    expect(listedSchedule(hourly, { every: 3_600_000, pattern: '' })).toEqual({
      kind: 'interval',
      intervalMs: 3_600_000,
    });
  });

  it('shows every reminder exactly as the flat-field read model did', () => {
    // The display rule before the union: description, else a truthy pattern, else the interval.
    const flatDisplay = (s: RecurringSchedule, every?: number, pattern?: string): string => {
      const cronPattern = s.kind === 'cron' ? s.cronPattern : pattern;
      const cronDescription = s.kind === 'cron' ? s.cronDescription : undefined;
      return cronDescription ?? (cronPattern ? cronPattern : `every ${formatDuration(every ?? 0)}`);
    };
    fc.assert(
      fc.property(
        fc.constantFrom(hourly, sundays),
        fc.option(fc.nat({ max: 10 * 86_400_000 }), { nil: undefined }),
        fc.option(fc.constantFrom('', '0 9 * * *', '*/5 * * * *'), { nil: undefined }),
        (template, every, pattern) => {
          const entry = {
            schedulerId: 's',
            text: 't',
            schedule: listedSchedule(template, { every, pattern }),
          };
          expect(formatReminderList([entry])).toContain(
            `1. \`s\` ${flatDisplay(template, every, pattern)} — t`,
          );
        },
      ),
    );
  });
});

// ─── parseActiveResearch ──────────────────────────────────────────────────────

describe('parseActiveResearch', () => {
  it('projects topic, state, progress and start time', () => {
    const parsed = parseActiveResearch(researchData);
    expect(parsed).toEqual({
      ok: true,
      value: {
        topic: 'quantum',
        state: 'querying',
        progress: expect.any(Number),
        startedAt: '2026-03-29T10:00:00Z',
      },
    });
    if (parsed.ok) expect(parsed.value.progress).toBeGreaterThan(0);
  });

  it('marks a context and state not yet filled in as unknown', () => {
    const bare = { ...researchData, state: {}, context: {} };
    expect(parseActiveResearch(bare)).toEqual({ ok: true, value: UNKNOWN_ACTIVE_RESEARCH });
  });

  it('fails on job data that is not a research job', () => {
    expect(parseActiveResearch({ prompt: '' }).ok).toBe(false);
  });
});
