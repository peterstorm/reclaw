import { describe, it, expect } from 'vitest';
import {
  makeSessionKey,
  makeMessageSessionKey,
  isSessionExpired,
  parseSessionRecord,
  serializeSessionRecord,
  type SessionRecord,
} from './session.js';
import type { ClaudeSessionId } from './types.js';

const SESSION_ID = 'abc-123' as ClaudeSessionId;

describe('makeSessionKey', () => {
  it('builds key with chatId', () => {
    expect(makeSessionKey(456)).toBe('reclaw-session-456');
  });

  it('uses no colons', () => {
    expect(makeSessionKey(789)).not.toContain(':');
  });
});

describe('makeMessageSessionKey', () => {
  it('builds key with messageId', () => {
    expect(makeMessageSessionKey(789)).toBe('reclaw-msg-session-789');
  });

  it('uses no colons', () => {
    expect(makeMessageSessionKey(123)).not.toContain(':');
  });
});

describe('isSessionExpired', () => {
  const record: SessionRecord = {
    sessionId: SESSION_ID,
    lastActivityAt: '2026-02-26T10:00:00.000Z',
  };
  const recordMs = new Date('2026-02-26T10:00:00.000Z').getTime();

  it('returns false when within timeout', () => {
    const now = recordMs + 1_000; // 1s later
    expect(isSessionExpired(record, now, 1_800_000)).toBe(false);
  });

  it('returns true when past timeout', () => {
    const now = recordMs + 1_800_001; // 30min + 1ms
    expect(isSessionExpired(record, now, 1_800_000)).toBe(true);
  });

  it('returns false at exact boundary', () => {
    const now = recordMs + 1_800_000; // exactly 30min
    expect(isSessionExpired(record, now, 1_800_000)).toBe(false);
  });
});

describe('parseSessionRecord', () => {
  it('parses valid JSON', () => {
    const raw = JSON.stringify({ sessionId: 'sess-1', lastActivityAt: '2026-02-26T10:00:00Z' });
    const result = parseSessionRecord(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sessionId).toBe('sess-1');
      expect(result.value.lastActivityAt).toBe('2026-02-26T10:00:00Z');
    }
  });

  it('returns error for invalid JSON', () => {
    const result = parseSessionRecord('not json');
    expect(result.ok).toBe(false);
  });

  it('returns error for missing sessionId', () => {
    const result = parseSessionRecord(JSON.stringify({ lastActivityAt: '2026-02-26T10:00:00Z' }));
    expect(result.ok).toBe(false);
  });

  it('returns error for empty sessionId', () => {
    const result = parseSessionRecord(JSON.stringify({ sessionId: '  ', lastActivityAt: '2026-02-26T10:00:00Z' }));
    expect(result.ok).toBe(false);
  });

  it('returns error for missing lastActivityAt', () => {
    const result = parseSessionRecord(JSON.stringify({ sessionId: 'sess-1' }));
    expect(result.ok).toBe(false);
  });
});

describe('serializeSessionRecord', () => {
  it('round-trips with parseSessionRecord', () => {
    const record: SessionRecord = {
      sessionId: SESSION_ID,
      lastActivityAt: '2026-02-26T10:00:00.000Z',
    };
    const serialized = serializeSessionRecord(record);
    const parsed = parseSessionRecord(serialized);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.sessionId).toBe(record.sessionId);
      expect(parsed.value.lastActivityAt).toBe(record.lastActivityAt);
    }
  });
});
