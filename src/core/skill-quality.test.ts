import { describe, it, expect } from 'vitest';
import { shouldRecord, toRecord, type SkillQualitySignal, type SkillRunStatus } from './skill-quality.js';
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

describe('toRecord', () => {
  it('returns null for success', () => {
    expect(toRecord(baseSignal({ status: 'success' }))).toBeNull();
  });

  it('returns null for validity_expired', () => {
    expect(toRecord(baseSignal({ status: 'validity_expired' }))).toBeNull();
  });

  it('produces a record for suppressed', () => {
    const rec = toRecord(baseSignal({ status: 'suppressed', outputLength: 0 }));
    expect(rec).not.toBeNull();
    expect(rec?.status).toBe('suppressed');
    expect(rec?.skillId).toBe('morning-briefing');
    expect(rec?.severity).toBe(5);
    expect(rec?.summary).toContain('ALL_CLEAR');
    expect(rec?.summary).toContain('morning-briefing');
    expect(rec?.summary).toContain('1234ms');
    expect(rec?.timestamp).toBe('2026-04-25T07:00:12.000Z');
  });

  it('produces a record for claude_error including the reason', () => {
    const rec = toRecord(
      baseSignal({ status: 'claude_error', errorMessage: 'subprocess timed out after 300s' }),
    );
    expect(rec).not.toBeNull();
    expect(rec?.status).toBe('claude_error');
    expect(rec?.errorMessage).toBe('subprocess timed out after 300s');
    expect(rec?.summary).toContain('subprocess timed out after 300s');
    expect(rec?.severity).toBeGreaterThanOrEqual(7);
  });

  it('uses "unknown error" placeholder in the summary when errorMessage missing', () => {
    const rec = toRecord(baseSignal({ status: 'claude_error', errorMessage: null }));
    expect(rec?.summary).toContain('unknown error');
    expect(rec?.errorMessage).toBeNull();
  });

  it('produces a record for skill_not_found', () => {
    const rec = toRecord(baseSignal({ status: 'skill_not_found' }));
    expect(rec?.status).toBe('skill_not_found');
    expect(rec?.severity).toBe(8);
    expect(rec?.summary).toContain('missing from registry');
  });

  it('serializes cleanly to one JSONL line', () => {
    const rec = toRecord(baseSignal({ status: 'claude_error', errorMessage: 'boom' }));
    const line = JSON.stringify(rec);
    expect(line).not.toContain('\n');
    expect(JSON.parse(line).skillId).toBe('morning-briefing');
  });
});
