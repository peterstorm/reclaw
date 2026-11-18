import type { JobSchedulerJson } from 'bullmq';
import { describe, expect, it } from 'vitest';
import {
  type RecurringSchedule,
  type RecurringScheduleSpec,
  makeRecurringSchedule,
} from '../core/types.js';
import {
  UNKNOWN_ACTIVE_RESEARCH,
  parseActiveResearch,
  readReminderScheduler,
  schedulerInfoFromSchedule,
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
      info: { schedulerId: 'sched-001', text: 'stand up', intervalMs: 3600000, chatId: 123 },
    });
  });

  it('reads a cron scheduler, falling back to the scheduler pattern', () => {
    const reading = readReminderScheduler(scheduler({ pattern: '0 12 * * 0' }));
    expect(reading).toEqual({
      kind: 'reminder',
      info: {
        schedulerId: 'sched-001',
        text: 'stand up',
        intervalMs: 0,
        cronPattern: '0 12 * * 0',
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
      info: { cronPattern: '0 12 * * 0', cronDescription: 'every Sunday' },
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

// ─── schedulerInfoFromSchedule ────────────────────────────────────────────────

describe('schedulerInfoFromSchedule', () => {
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

  it('reports an interval schedule the scheduler agrees with', () => {
    expect(schedulerInfoFromSchedule(hourly, { every: 3_600_000 })).toEqual({
      intervalMs: 3_600_000,
    });
  });

  it('reports a cron schedule the scheduler agrees with, with its description', () => {
    expect(schedulerInfoFromSchedule(sundays, { pattern: '0 12 * * 0' })).toEqual({
      intervalMs: 0,
      cronPattern: '0 12 * * 0',
      cronDescription: 'every Sunday',
    });
  });

  it('takes the interval from the scheduler, which is what BullMQ fires on', () => {
    expect(schedulerInfoFromSchedule(hourly, { every: 7_200_000 })).toEqual({
      intervalMs: 7_200_000,
    });
    expect(schedulerInfoFromSchedule(sundays, { every: 7_200_000 })).toEqual({
      intervalMs: 7_200_000,
      cronPattern: '0 12 * * 0',
      cronDescription: 'every Sunday',
    });
  });

  it('reports no interval when the scheduler has none, whatever the template says', () => {
    expect(schedulerInfoFromSchedule(hourly, { pattern: '0 9 * * *' })).toEqual({
      intervalMs: 0,
      cronPattern: '0 9 * * *',
    });
  });

  it('takes the pattern and description from a cron template over the scheduler pattern', () => {
    expect(schedulerInfoFromSchedule(sundays, { pattern: '0 9 * * *' })).toEqual({
      intervalMs: 0,
      cronPattern: '0 12 * * 0',
      cronDescription: 'every Sunday',
    });
  });

  it('falls back to the scheduler pattern only when the template is an interval', () => {
    expect(schedulerInfoFromSchedule(hourly, { every: 3_600_000, pattern: '0 9 * * *' })).toEqual({
      intervalMs: 3_600_000,
      cronPattern: '0 9 * * *',
    });
    expect(schedulerInfoFromSchedule(hourly, { every: 3_600_000, pattern: '' })).toEqual({
      intervalMs: 3_600_000,
    });
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
