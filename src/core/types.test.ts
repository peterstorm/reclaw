import { describe, expect, it } from 'vitest';
import {
  err,
  flatMapResult,
  isChatJob,
  isScheduledJob,
  makeChatJob,
  makeJobId,
  makeScheduledJob,
  makeSkillId,
  makeTelegramUserId,
  mapResult,
  ok,
  emptySkillRegistry,
  skillRegistryFromList,
  jobResultOk,
  jobResultErr,
} from './types.js';
import type { JobId, SkillConfig, SkillId, TelegramUserId } from './types.js';

// ─── isIso8601 (via makeChatJob / makeScheduledJob) ───────────────────────────

describe('isIso8601 (informal date rejection)', () => {
  function validSetup() {
    const id = makeJobId('job-001');
    const uid = makeTelegramUserId(1);
    if (!id.ok || !uid.ok) throw new Error('bad test setup');
    return { id: id.value, userId: uid.value };
  }

  it('rejects "tomorrow" as receivedAt', () => {
    const { id, userId } = validSetup();
    const r = makeChatJob({ id, userId, text: 'hi', chatId: 1, receivedAt: 'tomorrow' });
    expect(r.ok).toBe(false);
  });

  it('rejects "Feb 26 2026" as receivedAt', () => {
    const { id, userId } = validSetup();
    const r = makeChatJob({ id, userId, text: 'hi', chatId: 1, receivedAt: 'Feb 26 2026' });
    expect(r.ok).toBe(false);
  });

  it('rejects bare year "2024" as receivedAt', () => {
    const { id, userId } = validSetup();
    const r = makeChatJob({ id, userId, text: 'hi', chatId: 1, receivedAt: '2024' });
    expect(r.ok).toBe(false);
  });

  it('accepts ISO 8601 date-time with Z', () => {
    const { id, userId } = validSetup();
    const r = makeChatJob({ id, userId, text: 'hi', chatId: 1, receivedAt: '2024-01-15T10:30:00Z' });
    expect(r.ok).toBe(true);
  });

  it('accepts ISO 8601 date-only string', () => {
    const skillId = makeSkillId('s');
    const jobId = makeJobId('j');
    if (!skillId.ok || !jobId.ok) throw new Error('bad test setup');
    const r = makeScheduledJob({
      id: jobId.value,
      skillId: skillId.value,
      triggeredAt: '2024-01-15',
      validUntil: '2024-01-16',
    });
    expect(r.ok).toBe(true);
  });
});

// ─── Branded Type Constructors ────────────────────────────────────────────────

describe('makeTelegramUserId', () => {
  it('accepts positive integers', () => {
    const r = makeTelegramUserId(123456789);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(123456789);
  });

  it('rejects zero', () => {
    const r = makeTelegramUserId(0);
    expect(r.ok).toBe(false);
  });

  it('rejects negative numbers', () => {
    const r = makeTelegramUserId(-1);
    expect(r.ok).toBe(false);
  });

  it('rejects floats', () => {
    const r = makeTelegramUserId(1.5);
    expect(r.ok).toBe(false);
  });
});

describe('makeJobId', () => {
  it('accepts non-empty strings', () => {
    const r = makeJobId('job-abc-123');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('job-abc-123');
  });

  it('rejects empty string', () => {
    const r = makeJobId('');
    expect(r.ok).toBe(false);
  });

  it('rejects whitespace-only string', () => {
    const r = makeJobId('   ');
    expect(r.ok).toBe(false);
  });
});

describe('makeSkillId', () => {
  it('accepts simple skill names', () => {
    const r = makeSkillId('morning-briefing');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('morning-briefing');
  });

  it('rejects empty string', () => {
    const r = makeSkillId('');
    expect(r.ok).toBe(false);
  });

  it('rejects strings with forward slash', () => {
    const r = makeSkillId('skills/morning');
    expect(r.ok).toBe(false);
  });

  it('rejects strings with backslash', () => {
    const r = makeSkillId('skills\\morning');
    expect(r.ok).toBe(false);
  });
});

// ─── Result Combinators ───────────────────────────────────────────────────────

describe('ok / err', () => {
  it('ok wraps value', () => {
    const r = ok(42);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(42);
  });

  it('err wraps error', () => {
    const r = err('something went wrong');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('something went wrong');
  });
});

describe('mapResult', () => {
  it('transforms ok value', () => {
    const r = mapResult(ok(2), (x) => x * 3);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(6);
  });

  it('passes through error unchanged', () => {
    const r = mapResult(err('fail'), (x: number) => x * 3);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('fail');
  });
});

describe('flatMapResult', () => {
  it('chains ok results', () => {
    const r = flatMapResult(ok(5), (x) => ok(x + 1));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(6);
  });

  it('short-circuits on first error', () => {
    const r = flatMapResult(err('first'), (_x: number) => ok(99));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('first');
  });

  it('propagates error from inner function', () => {
    const r = flatMapResult(ok(5), (_x) => err('inner fail'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('inner fail');
  });
});

// ─── Job Factory Functions ────────────────────────────────────────────────────

function validJobId(): JobId {
  const r = makeJobId('job-001');
  if (!r.ok) throw new Error('bad test setup');
  return r.value;
}

function validUserId(): TelegramUserId {
  const r = makeTelegramUserId(123456);
  if (!r.ok) throw new Error('bad test setup');
  return r.value;
}

function validSkillId(): SkillId {
  const r = makeSkillId('morning-briefing');
  if (!r.ok) throw new Error('bad test setup');
  return r.value;
}

describe('makeChatJob', () => {
  it('creates a valid chat job', () => {
    const r = makeChatJob({
      id: validJobId(),
      userId: validUserId(),
      text: 'Hello, agent!',
      chatId: 987654321,
      receivedAt: new Date().toISOString(),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.kind).toBe('chat');
      expect(r.value.text).toBe('Hello, agent!');
    }
  });

  it('rejects empty text', () => {
    const r = makeChatJob({
      id: validJobId(),
      userId: validUserId(),
      text: '',
      chatId: 987654321,
      receivedAt: new Date().toISOString(),
    });
    expect(r.ok).toBe(false);
  });

  it('rejects whitespace-only text', () => {
    const r = makeChatJob({
      id: validJobId(),
      userId: validUserId(),
      text: '   ',
      chatId: 987654321,
      receivedAt: new Date().toISOString(),
    });
    expect(r.ok).toBe(false);
  });

  it('rejects invalid receivedAt date', () => {
    const r = makeChatJob({
      id: validJobId(),
      userId: validUserId(),
      text: 'Hello',
      chatId: 987654321,
      receivedAt: 'not-a-date',
    });
    expect(r.ok).toBe(false);
  });

  it('rejects float chatId', () => {
    const r = makeChatJob({
      id: validJobId(),
      userId: validUserId(),
      text: 'Hello',
      chatId: 1.5,
      receivedAt: new Date().toISOString(),
    });
    expect(r.ok).toBe(false);
  });
});

describe('makeScheduledJob', () => {
  it('creates a valid scheduled job', () => {
    const triggered = new Date('2026-02-26T08:00:00.000Z');
    const validUntil = new Date('2026-02-26T08:30:00.000Z');
    const r = makeScheduledJob({
      id: validJobId(),
      skillId: validSkillId(),
      triggeredAt: triggered.toISOString(),
      validUntil: validUntil.toISOString(),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.kind).toBe('scheduled');
      expect(r.value.skillId).toBe('morning-briefing');
    }
  });

  it('rejects invalid triggeredAt', () => {
    const r = makeScheduledJob({
      id: validJobId(),
      skillId: validSkillId(),
      triggeredAt: 'bad',
      validUntil: new Date().toISOString(),
    });
    expect(r.ok).toBe(false);
  });

  it('rejects invalid validUntil', () => {
    const r = makeScheduledJob({
      id: validJobId(),
      skillId: validSkillId(),
      triggeredAt: new Date().toISOString(),
      validUntil: 'bad',
    });
    expect(r.ok).toBe(false);
  });

  it('rejects validUntil not after triggeredAt', () => {
    const t = new Date('2026-02-26T08:00:00.000Z').toISOString();
    const r = makeScheduledJob({
      id: validJobId(),
      skillId: validSkillId(),
      triggeredAt: t,
      validUntil: t, // same timestamp
    });
    expect(r.ok).toBe(false);
  });

  it('rejects validUntil before triggeredAt', () => {
    const r = makeScheduledJob({
      id: validJobId(),
      skillId: validSkillId(),
      triggeredAt: new Date('2026-02-26T08:00:00.000Z').toISOString(),
      validUntil: new Date('2026-02-26T07:00:00.000Z').toISOString(),
    });
    expect(r.ok).toBe(false);
  });
});

// ─── Type Guards ──────────────────────────────────────────────────────────────

describe('isChatJob / isScheduledJob', () => {
  it('isChatJob returns true for chat jobs', () => {
    const r = makeChatJob({
      id: validJobId(),
      userId: validUserId(),
      text: 'hi',
      chatId: 1,
      receivedAt: new Date().toISOString(),
    });
    if (!r.ok) throw new Error('setup');
    expect(isChatJob(r.value)).toBe(true);
    expect(isScheduledJob(r.value)).toBe(false);
  });

  it('isScheduledJob returns true for scheduled jobs', () => {
    const r = makeScheduledJob({
      id: validJobId(),
      skillId: validSkillId(),
      triggeredAt: new Date('2026-02-26T08:00:00.000Z').toISOString(),
      validUntil: new Date('2026-02-26T09:00:00.000Z').toISOString(),
    });
    if (!r.ok) throw new Error('setup');
    expect(isScheduledJob(r.value)).toBe(true);
    expect(isChatJob(r.value)).toBe(false);
  });
});

// ─── JobResult ────────────────────────────────────────────────────────────────

describe('jobResultOk / jobResultErr', () => {
  it('jobResultOk builds success', () => {
    const r = jobResultOk('great response');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.response).toBe('great response');
  });

  it('jobResultErr builds failure', () => {
    const r = jobResultErr('timed out');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('timed out');
  });
});

// ─── SkillRegistry ────────────────────────────────────────────────────────────

describe('emptySkillRegistry', () => {
  it('returns empty map', () => {
    const reg = emptySkillRegistry();
    expect(reg.size).toBe(0);
  });
});

describe('skillRegistryFromList', () => {
  function makeSkillConfig(idStr: string): SkillConfig {
    const idResult = makeSkillId(idStr);
    if (!idResult.ok) throw new Error('bad test setup');
    return {
      id: idResult.value,
      name: 'Test Skill',
      schedule: null,
      promptTemplate: 'Do something.',
      permissionProfile: 'chat',
      validityWindowMinutes: 30,
      timeout: 120,
    };
  }

  it('builds registry from list', () => {
    const skills = [makeSkillConfig('skill-a'), makeSkillConfig('skill-b')];
    const reg = skillRegistryFromList(skills);
    expect(reg.size).toBe(2);
    expect(reg.has('skill-a' as SkillId)).toBe(true);
    expect(reg.has('skill-b' as SkillId)).toBe(true);
  });

  it('handles empty list', () => {
    const reg = skillRegistryFromList([]);
    expect(reg.size).toBe(0);
  });

  it('last entry wins for duplicate ids', () => {
    const s1 = makeSkillConfig('skill-a');
    const s2 = { ...makeSkillConfig('skill-a'), name: 'Updated' };
    const reg = skillRegistryFromList([s1, s2]);
    expect(reg.size).toBe(1);
    expect(reg.get('skill-a' as SkillId)?.name).toBe('Updated');
  });
});
