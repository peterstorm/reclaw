import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  parseChatJob,
  parsePodcastJob,
  parseRecurringReminderJob,
  parseReminderJob,
  parseResearchJobData,
  parseScheduledJob,
  recurringReminderJobToWire,
} from './job-schemas.js';
import {
  MAX_REPLY_CONTEXT_CHARS,
  type RecurringReminderJob,
  type RecurringSchedule,
  makeJobId,
  makeRecurringReminderJob,
} from './types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function validChatData() {
  return {
    kind: 'chat' as const,
    id: 'job-001',
    userId: 42,
    text: 'hello',
    chatId: 123,
    receivedAt: '2026-03-29T10:00:00Z',
    conversation: {
      generation: 0,
      revision: 0,
      backend: 'pi' as const,
      sessionId: null,
    },
  };
}

function validScheduledData() {
  return {
    kind: 'scheduled' as const,
    id: 'job-002',
    skillId: 'morning-briefing',
    triggeredAt: '2026-03-29T08:00:00Z',
    validUntil: '2026-03-29T09:00:00Z',
  };
}

function validReminderData() {
  return {
    kind: 'reminder' as const,
    id: 'job-003',
    chatId: 123,
    text: 'take medicine',
    createdAt: '2026-03-29T10:00:00Z',
    delayMs: 3600000,
  };
}

function validRecurringReminderData() {
  return {
    kind: 'recurring-reminder' as const,
    id: 'job-004',
    chatId: 123,
    text: 'stand up',
    createdAt: '2026-03-29T10:00:00Z',
    intervalMs: 3600000,
    schedulerId: 'sched-001',
  };
}

function validResearchData() {
  return {
    prompt: 'Research quantum computing advancements',
    sourceHints: ['https://arxiv.org'],
    chatId: 123,
    state: { kind: 'deriving_topic' },
    context: { topic: '', prompt: 'Research quantum computing advancements', topicSlug: null },
  };
}

function validPodcastData() {
  return {
    kind: 'podcast' as const,
    id: 'job-005',
    chatId: 123,
    notePath: 'notes/topic.md',
    audioFormat: 1 as const,
    audioLength: 2 as const,
    enqueuedAt: '2026-03-29T10:00:00Z',
  };
}

// ─── parseChatJob ───────────────────────────────────────────────────────────

describe('parseChatJob', () => {
  it('parses valid chat job data', () => {
    const result = parseChatJob(validChatData());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('chat');
    expect(result.value.id).toBe('job-001');
    expect(result.value.userId).toBe(42);
    expect(result.value.text).toBe('hello');
  });

  it('rejects missing kind', () => {
    const { kind: _, ...data } = validChatData();
    expect(parseChatJob(data).ok).toBe(false);
  });

  it('rejects wrong kind', () => {
    expect(parseChatJob({ ...validChatData(), kind: 'scheduled' }).ok).toBe(false);
  });

  it('rejects a job without its immutable conversation target', () => {
    const { conversation: _conversation, ...legacy } = validChatData();
    expect(parseChatJob(legacy).ok).toBe(false);
  });

  it('rejects empty id', () => {
    expect(parseChatJob({ ...validChatData(), id: '' }).ok).toBe(false);
  });

  it('rejects non-positive userId', () => {
    expect(parseChatJob({ ...validChatData(), userId: 0 }).ok).toBe(false);
    expect(parseChatJob({ ...validChatData(), userId: -1 }).ok).toBe(false);
  });

  it('rejects non-integer userId', () => {
    expect(parseChatJob({ ...validChatData(), userId: 1.5 }).ok).toBe(false);
  });

  it('rejects empty text without an attachment', () => {
    expect(parseChatJob({ ...validChatData(), text: '' }).ok).toBe(false);
  });

  it.each(['123', 'too:many:colon:segments'])('rejects invalid BullMQ job ID %j', (id) => {
    expect(parseChatJob({ ...validChatData(), id }).ok).toBe(false);
  });

  it('rejects a non-ISO receivedAt timestamp', () => {
    expect(parseChatJob({ ...validChatData(), receivedAt: 'yesterday' }).ok).toBe(false);
  });

  it('parses bounded textual and non-text reply contexts', () => {
    const textual = parseChatJob({
      ...validChatData(),
      replyContext: {
        kind: 'text',
        messageId: 42,
        author: 'assistant',
        text: 'Garmin sync failed',
        truncated: false,
      },
    });
    const nonText = parseChatJob({
      ...validChatData(),
      replyContext: { kind: 'non-text', messageId: 43, author: 'other' },
    });
    expect(textual.ok).toBe(true);
    expect(nonText.ok).toBe(true);
  });

  it.each([
    { kind: 'text', messageId: 0, author: 'assistant', text: 'x', truncated: false },
    {
      kind: 'text',
      messageId: Number.MAX_SAFE_INTEGER + 1,
      author: 'assistant',
      text: 'x',
      truncated: false,
    },
    { kind: 'text', messageId: 42, author: 'unknown', text: 'x', truncated: false },
    {
      kind: 'text',
      messageId: 42,
      author: 'assistant',
      text: 'x'.repeat(MAX_REPLY_CONTEXT_CHARS + 1),
      truncated: true,
    },
    { kind: 'non-text', messageId: 0, author: 'other' },
  ])('rejects malformed durable reply context %#', (replyContext) => {
    expect(parseChatJob({ ...validChatData(), replyContext }).ok).toBe(false);
  });

  it('parses chat job with imagePaths', () => {
    const data = { ...validChatData(), imagePaths: ['/tmp/reclaw-images/test.jpg'] };
    const result = parseChatJob(data);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.imagePaths).toEqual(['/tmp/reclaw-images/test.jpg']);
    }
  });

  it('parses chat job without imagePaths', () => {
    const result = parseChatJob(validChatData());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.imagePaths).toBeUndefined();
    }
  });

  it('parses chat jobs with extracted PDF text paths', () => {
    const data = { ...validChatData(), text: '', documentPaths: ['/state/1001.pdf.txt'] };
    const result = parseChatJob(data);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.documentPaths).toEqual(['/state/1001.pdf.txt']);
  });

  it('parses chat jobs with permanent uploads', () => {
    const storedUploads = [
      {
        path: '/data/telegram-1.skill',
        displayName: 'bundle.skill',
        mimeType: 'application/octet-stream',
        sizeBytes: 4,
      },
    ];
    const result = parseChatJob({ ...validChatData(), text: '', storedUploads });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.storedUploads).toEqual(storedUploads);
  });

  it.each([
    { imagePaths: [''] },
    { documentPaths: [''] },
    {
      storedUploads: [
        { path: '/data/file.skill', displayName: 'bad\nname', mimeType: null, sizeBytes: 4 },
      ],
    },
  ])('rejects malformed attachment metadata: $imagePaths$documentPaths$storedUploads', (paths) => {
    expect(parseChatJob({ ...validChatData(), ...paths }).ok).toBe(false);
  });

  it('rejects null input', () => {
    expect(parseChatJob(null).ok).toBe(false);
  });

  it('rejects undefined input', () => {
    expect(parseChatJob(undefined).ok).toBe(false);
  });
});

// ─── parseScheduledJob ──────────────────────────────────────────────────────

describe('parseScheduledJob', () => {
  it('parses valid scheduled job data', () => {
    const result = parseScheduledJob(validScheduledData());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('scheduled');
    expect(result.value.skillId).toBe('morning-briefing');
  });

  it.each(['', '../morning-briefing', 'folder\\skill'])('rejects invalid skillId %j', (skillId) => {
    expect(parseScheduledJob({ ...validScheduledData(), skillId }).ok).toBe(false);
  });

  it('rejects missing triggeredAt', () => {
    const { triggeredAt: _, ...data } = validScheduledData();
    expect(parseScheduledJob(data).ok).toBe(false);
  });

  it('rejects wrong kind', () => {
    expect(parseScheduledJob({ ...validScheduledData(), kind: 'chat' }).ok).toBe(false);
  });

  it.each([
    { triggeredAt: 'not-a-date' },
    { validUntil: 'not-a-date' },
    { validUntil: '2026-03-29T07:59:59Z' },
    { validUntil: '2026-03-29T08:00:00Z' },
  ])('rejects invalid or non-increasing persisted deadlines %#', (overrides) => {
    expect(parseScheduledJob({ ...validScheduledData(), ...overrides }).ok).toBe(false);
  });

  it('preserves an explicit manual trigger', () => {
    const result = parseScheduledJob({ ...validScheduledData(), trigger: 'manual' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.trigger).toBe('manual');
  });

  // Jobs enqueued before `trigger` existed are still sitting in Redis across the
  // deploy that introduced it. They must parse, not dead-letter, and they were
  // all cron-fired.
  it('defaults a job with no trigger field to cron (backwards compatibility)', () => {
    const { trigger: _, ...legacy } = { ...validScheduledData(), trigger: 'cron' };
    const result = parseScheduledJob(legacy);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.trigger).toBe('cron');
  });

  it('rejects an unrecognised trigger rather than silently defaulting it', () => {
    expect(parseScheduledJob({ ...validScheduledData(), trigger: 'webhook' }).ok).toBe(false);
  });
});

// ─── parseReminderJob ───────────────────────────────────────────────────────

describe('parseReminderJob', () => {
  it('parses valid reminder job data', () => {
    const result = parseReminderJob(validReminderData());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('reminder');
    expect(result.value.text).toBe('take medicine');
    expect(result.value.delayMs).toBe(3600000);
  });

  it('rejects zero delayMs', () => {
    expect(parseReminderJob({ ...validReminderData(), delayMs: 0 }).ok).toBe(false);
  });

  it('rejects negative delayMs', () => {
    expect(parseReminderJob({ ...validReminderData(), delayMs: -100 }).ok).toBe(false);
  });

  it('rejects empty text', () => {
    expect(parseReminderJob({ ...validReminderData(), text: '' }).ok).toBe(false);
  });
});

// ─── parseRecurringReminderJob ──────────────────────────────────────────────

describe('parseRecurringReminderJob', () => {
  it('parses valid recurring reminder with interval', () => {
    const result = parseRecurringReminderJob(validRecurringReminderData());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('recurring-reminder');
    expect(result.value.schedulerId).toBe('sched-001');
  });

  it('parses with optional cron fields', () => {
    const data = {
      ...validRecurringReminderData(),
      intervalMs: 0,
      cronPattern: '0 12 * * 0',
      cronDescription: 'every Sunday at noon',
    };
    const result = parseRecurringReminderJob(data);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.schedule).toEqual({
      kind: 'cron',
      cronPattern: '0 12 * * 0',
      cronDescription: 'every Sunday at noon',
    });
  });

  it('defaults a missing cron description to the cron pattern', () => {
    const result = parseRecurringReminderJob({
      ...validRecurringReminderData(),
      intervalMs: 0,
      cronPattern: '0 9 * * 1-5',
    });
    expect(result.ok && result.value.schedule).toEqual({
      kind: 'cron',
      cronPattern: '0 9 * * 1-5',
      cronDescription: '0 9 * * 1-5',
    });
  });

  it('rejects a job with both an interval and a cron pattern', () => {
    expect(
      parseRecurringReminderJob({
        ...validRecurringReminderData(),
        intervalMs: 7_200_000,
        cronPattern: '0 12 * * 0',
      }),
    ).toEqual({
      ok: false,
      error:
        'Invalid recurring reminder job: Cannot specify both intervalMs and cronPattern for a recurring reminder.',
    });
  });

  it.each([{ intervalMs: 0 }, { intervalMs: 0, cronPattern: '' }, { intervalMs: -60_000 }])(
    'rejects a job with neither an interval nor a cron pattern %#',
    (overrides) => {
      expect(parseRecurringReminderJob({ ...validRecurringReminderData(), ...overrides })).toEqual({
        ok: false,
        error: 'Invalid recurring reminder job: Either intervalMs or cronPattern must be provided.',
      });
    },
  );

  it('rejects empty schedulerId', () => {
    expect(parseRecurringReminderJob({ ...validRecurringReminderData(), schedulerId: '' }).ok).toBe(
      false,
    );
  });

  it('rejects empty id', () => {
    expect(parseRecurringReminderJob({ ...validRecurringReminderData(), id: '' }).ok).toBe(false);
  });

  it.each([
    { intervalMs: 0 },
    { intervalMs: 59_999 },
    { intervalMs: 60_000, cronPattern: '0 12 * * 0' },
  ])('rejects invalid interval/cron combinations %#', (overrides) => {
    expect(parseRecurringReminderJob({ ...validRecurringReminderData(), ...overrides }).ok).toBe(
      false,
    );
  });
});

// ─── Recurring reminder wire codec ──────────────────────────────────────────
// BullMQ persists a recurring reminder's job data in Redis as the scheduler's
// template, and live reminders keep firing from it. The stored shape is fixed:
// these tests pin it byte for byte and prove the internal union round-trips.

/** Exactly what a producer wrote to Redis before the schedule became a union. */
const STORED_INTERVAL_JOB =
  '{"kind":"recurring-reminder","id":"telegram:1001:recurring","chatId":456,"text":"water","createdAt":"2026-03-04T10:00:00.000Z","intervalMs":7200000,"schedulerId":"telegram:1001:recurring"}';
const STORED_CRON_JOB =
  '{"kind":"recurring-reminder","id":"telegram:1002:recurring","chatId":456,"text":"water plants","createdAt":"2026-03-04T10:00:00.000Z","intervalMs":0,"cronPattern":"0 12 * * 0","cronDescription":"every Sunday at 12:00","schedulerId":"telegram:1002:recurring"}';

/** Read stored job data back the way Redis hands it over: untyped. */
const readStored = (json: string): unknown => JSON.parse(json);

describe('recurring reminder wire codec', () => {
  it('parses an interval reminder stored in the persisted shape', () => {
    const result = parseRecurringReminderJob(readStored(STORED_INTERVAL_JOB));
    expect(result).toEqual({
      ok: true,
      value: {
        kind: 'recurring-reminder',
        id: 'telegram:1001:recurring',
        chatId: 456,
        text: 'water',
        createdAt: '2026-03-04T10:00:00.000Z',
        schedule: { kind: 'interval', intervalMs: 7_200_000 },
        schedulerId: 'telegram:1001:recurring',
      },
    });
  });

  it('parses a cron reminder stored in the persisted shape', () => {
    const result = parseRecurringReminderJob(readStored(STORED_CRON_JOB));
    expect(result.ok && result.value.schedule).toEqual({
      kind: 'cron',
      cronPattern: '0 12 * * 0',
      cronDescription: 'every Sunday at 12:00',
    });
  });

  it.each([STORED_INTERVAL_JOB, STORED_CRON_JOB])(
    'writes the persisted bytes unchanged after a parse %#',
    (stored) => {
      const parsed = parseRecurringReminderJob(readStored(stored));
      if (!parsed.ok) throw new Error(parsed.error);
      expect(JSON.stringify(recurringReminderJobToWire(parsed.value))).toBe(stored);
    },
  );

  const scheduleArb: fc.Arbitrary<RecurringSchedule> = fc.oneof(
    fc
      .integer({ min: 60_000, max: 365 * 86_400_000 })
      .map((intervalMs) => ({ kind: 'interval' as const, intervalMs })),
    fc
      .record({
        cronPattern: fc.string({ minLength: 1, maxLength: 30 }),
        cronDescription: fc.string({ maxLength: 40 }),
      })
      .map((cron) => ({ kind: 'cron' as const, ...cron })),
  );

  const jobArb: fc.Arbitrary<RecurringReminderJob> = fc
    .record({
      update: fc.integer({ min: 0, max: 2 ** 40 }),
      chatId: fc.integer({ min: -(2 ** 40), max: 2 ** 40 }),
      text: fc.string({ minLength: 1, maxLength: 60 }).filter((t) => t.trim().length > 0),
      createdAt: fc
        .date({
          min: new Date('2020-01-01T00:00:00Z'),
          max: new Date('2030-01-01T00:00:00Z'),
          noInvalidDate: true,
        })
        .map((d) => d.toISOString()),
      schedule: scheduleArb,
    })
    .map(({ update, chatId, text, createdAt, schedule }) => {
      const id = makeJobId(`telegram:${update}:recurring`);
      if (!id.ok) throw new Error(id.error);
      const job = makeRecurringReminderJob({
        id: id.value,
        chatId,
        text,
        createdAt,
        schedule,
        schedulerId: id.value,
      });
      if (!job.ok) throw new Error(job.error);
      return job.value;
    });

  it('property: union → wire → union is the identity', () => {
    fc.assert(
      fc.property(jobArb, (job) => {
        const wire = readStored(JSON.stringify(recurringReminderJobToWire(job)));
        expect(parseRecurringReminderJob(wire)).toEqual({ ok: true, value: job });
      }),
    );
  });

  it('property: the wire carries exactly one schedule, in the persisted field layout', () => {
    fc.assert(
      fc.property(jobArb, (job) => {
        const wire = recurringReminderJobToWire(job);
        const { schedule } = job;
        if (schedule.kind === 'interval') {
          expect(Object.keys(wire)).toEqual([
            'kind',
            'id',
            'chatId',
            'text',
            'createdAt',
            'intervalMs',
            'schedulerId',
          ]);
          expect(wire.intervalMs).toBe(schedule.intervalMs);
        } else {
          expect(Object.keys(wire)).toEqual([
            'kind',
            'id',
            'chatId',
            'text',
            'createdAt',
            'intervalMs',
            'cronPattern',
            'cronDescription',
            'schedulerId',
          ]);
          expect(wire).toMatchObject({
            intervalMs: 0,
            cronPattern: schedule.cronPattern,
            cronDescription: schedule.cronDescription,
          });
        }
      }),
    );
  });
});

// ─── parseResearchJobData ───────────────────────────────────────────────────

describe('parseResearchJobData', () => {
  it('parses valid research job data', () => {
    const result = parseResearchJobData(validResearchData());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.prompt).toBe('Research quantum computing advancements');
    expect(result.value.chatId).toBe(123);
  });

  it('rejects empty prompt', () => {
    expect(parseResearchJobData({ ...validResearchData(), prompt: '' }).ok).toBe(false);
  });

  it('preserves extra fields via passthrough', () => {
    const data = { ...validResearchData(), extraField: 'preserved' };
    const result = parseResearchJobData(data);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.value as Record<string, unknown>).extraField).toBe('preserved');
  });
});

// ─── parsePodcastJob ────────────────────────────────────────────────────────

describe('parsePodcastJob', () => {
  it('parses valid podcast job data', () => {
    const result = parsePodcastJob(validPodcastData());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('podcast');
    expect(result.value.notePath).toBe('notes/topic.md');
    expect(result.value.audioFormat).toBe(1);
    expect(result.value.audioLength).toBe(2);
  });

  it('rejects invalid audioFormat', () => {
    expect(parsePodcastJob({ ...validPodcastData(), audioFormat: 5 }).ok).toBe(false);
  });

  it('rejects invalid audioLength', () => {
    expect(parsePodcastJob({ ...validPodcastData(), audioLength: 0 }).ok).toBe(false);
  });

  it('rejects empty notePath', () => {
    expect(parsePodcastJob({ ...validPodcastData(), notePath: '' }).ok).toBe(false);
  });

  it.each(['../outside.md', '/etc/passwd', 'folder\\..\\outside.md'])(
    'rejects unsafe persisted notePath %j',
    (notePath) => {
      expect(parsePodcastJob({ ...validPodcastData(), notePath }).ok).toBe(false);
    },
  );

  it('rejects empty enqueuedAt', () => {
    expect(parsePodcastJob({ ...validPodcastData(), enqueuedAt: '' }).ok).toBe(false);
  });
});
