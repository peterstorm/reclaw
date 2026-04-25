import { describe, it, expect } from 'vitest';
import { shouldRecord, toMemory, type SkillQualitySignal, type SkillRunStatus } from './skill-quality.js';
import type { SkillId } from './types.js';

const skillId = 'morning-briefing' as SkillId;

const baseSignal = (overrides: Partial<SkillQualitySignal> = {}): SkillQualitySignal => ({
  skillId,
  status: 'success',
  durationMs: 1234,
  outputLength: 500,
  errorMessage: null,
  timestamp: '2026-04-25T07:00:12.000Z',
  ...overrides,
});

describe('shouldRecord', () => {
  it.each<[SkillRunStatus, boolean]>([
    ['success', false],
    ['validity_expired', false],
    ['suppressed', true],
    ['claude_error', true],
    ['skill_not_found', true],
  ])('status=%s → %s', (status, expected) => {
    expect(shouldRecord(status)).toBe(expected);
  });
});

describe('toMemory', () => {
  it('returns null for success', () => {
    expect(toMemory(baseSignal({ status: 'success' }))).toBeNull();
  });

  it('returns null for validity_expired', () => {
    expect(toMemory(baseSignal({ status: 'validity_expired' }))).toBeNull();
  });

  it('produces a pattern memory for suppressed', () => {
    const mem = toMemory(baseSignal({ status: 'suppressed', outputLength: 0 }));
    expect(mem).not.toBeNull();
    expect(mem?.type).toBe('pattern');
    expect(mem?.tags).toEqual(['skill-quality', skillId, 'suppressed']);
    expect(mem?.content).toContain('ALL_CLEAR');
    expect(mem?.content).toContain('morning-briefing');
    expect(mem?.content).toContain('1234ms');
  });

  it('produces a gotcha memory for claude_error including the reason', () => {
    const mem = toMemory(
      baseSignal({ status: 'claude_error', errorMessage: 'subprocess timed out after 300s' }),
    );
    expect(mem).not.toBeNull();
    expect(mem?.type).toBe('gotcha');
    expect(mem?.tags).toEqual(['skill-quality', skillId, 'claude_error']);
    expect(mem?.content).toContain('subprocess timed out after 300s');
    expect(mem?.priority).toBeGreaterThanOrEqual(7);
  });

  it('uses "unknown error" placeholder when errorMessage missing', () => {
    const mem = toMemory(baseSignal({ status: 'claude_error', errorMessage: null }));
    expect(mem?.content).toContain('unknown error');
  });

  it('produces a gotcha memory for skill_not_found', () => {
    const mem = toMemory(baseSignal({ status: 'skill_not_found' }));
    expect(mem?.type).toBe('gotcha');
    expect(mem?.content).toContain('missing from registry');
    expect(mem?.tags).toEqual(['skill-quality', skillId, 'skill_not_found']);
  });
});
