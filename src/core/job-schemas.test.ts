import { describe, expect, it } from 'vitest';
import {
  parseChatJob,
  parsePodcastJob,
  parseRecurringReminderJob,
  parseReminderJob,
  parseResearchJobData,
  parseScheduledJob,
} from './job-schemas.js';
import { MAX_REPLY_CONTEXT_CHARS } from './types.js';

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
    expect(result.value.cronPattern).toBe('0 12 * * 0');
  });

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
