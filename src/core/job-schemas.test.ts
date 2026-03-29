import { describe, expect, it } from 'vitest';
import {
  parseChatJob,
  parseScheduledJob,
  parseReminderJob,
  parseRecurringReminderJob,
  parseResearchJobData,
  parsePodcastJob,
} from './job-schemas.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function validChatData() {
  return {
    kind: 'chat' as const,
    id: 'job-001',
    userId: 42,
    text: 'hello',
    chatId: 123,
    receivedAt: '2026-03-29T10:00:00Z',
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
    topic: 'quantum computing',
    prompt: null,
    topicSlug: 'quantum-computing',
    sourceHints: ['https://arxiv.org'],
    chatId: 123,
    state: { kind: 'creating_notebook' },
    context: { topic: 'quantum computing' },
  };
}

function validPodcastData() {
  return {
    kind: 'podcast' as const,
    id: 'job-005',
    chatId: 123,
    notePath: '/notes/topic.md',
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

  it('rejects empty text', () => {
    expect(parseChatJob({ ...validChatData(), text: '' }).ok).toBe(false);
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

  it('rejects empty skillId', () => {
    expect(parseScheduledJob({ ...validScheduledData(), skillId: '' }).ok).toBe(false);
  });

  it('rejects missing triggeredAt', () => {
    const { triggeredAt: _, ...data } = validScheduledData();
    expect(parseScheduledJob(data).ok).toBe(false);
  });

  it('rejects wrong kind', () => {
    expect(parseScheduledJob({ ...validScheduledData(), kind: 'chat' }).ok).toBe(false);
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
      cronPattern: '0 12 * * 0',
      cronDescription: 'every Sunday at noon',
    };
    const result = parseRecurringReminderJob(data);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cronPattern).toBe('0 12 * * 0');
  });

  it('rejects empty schedulerId', () => {
    expect(parseRecurringReminderJob({ ...validRecurringReminderData(), schedulerId: '' }).ok).toBe(false);
  });

  it('rejects empty id', () => {
    expect(parseRecurringReminderJob({ ...validRecurringReminderData(), id: '' }).ok).toBe(false);
  });
});

// ─── parseResearchJobData ───────────────────────────────────────────────────

describe('parseResearchJobData', () => {
  it('parses valid research job data', () => {
    const result = parseResearchJobData(validResearchData());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.topic).toBe('quantum computing');
    expect(result.value.topicSlug).toBe('quantum-computing');
  });

  it('accepts null prompt', () => {
    const result = parseResearchJobData({ ...validResearchData(), prompt: null });
    expect(result.ok).toBe(true);
  });

  it('rejects empty topic', () => {
    expect(parseResearchJobData({ ...validResearchData(), topic: '' }).ok).toBe(false);
  });

  it('rejects empty topicSlug', () => {
    expect(parseResearchJobData({ ...validResearchData(), topicSlug: '' }).ok).toBe(false);
  });

  it('preserves extra fields via passthrough', () => {
    const data = { ...validResearchData(), extraField: 'preserved' };
    const result = parseResearchJobData(data);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.value as Record<string, unknown>)['extraField']).toBe('preserved');
  });
});

// ─── parsePodcastJob ────────────────────────────────────────────────────────

describe('parsePodcastJob', () => {
  it('parses valid podcast job data', () => {
    const result = parsePodcastJob(validPodcastData());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('podcast');
    expect(result.value.notePath).toBe('/notes/topic.md');
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

  it('rejects empty enqueuedAt', () => {
    expect(parsePodcastJob({ ...validPodcastData(), enqueuedAt: '' }).ok).toBe(false);
  });
});
