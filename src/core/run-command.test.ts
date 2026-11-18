import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type RunRejection,
  findRunSkill,
  formatRunRejection,
  manualRunWindow,
  parseRunCommand,
} from './run-command.js';
import { type SkillConfig, type SkillId, makeSkillId, skillRegistryFromList } from './types.js';

const skillId = (raw: string): SkillId => {
  const parsed = makeSkillId(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

const skill = (id: string): SkillConfig => ({
  id: skillId(id),
  name: id,
  schedule: null,
  promptTemplate: 'Do it.',
  permissionProfile: 'scheduled',
  validityWindowMinutes: 30,
  environment: [],
  dependsOn: null,
});

describe('parseRunCommand', () => {
  it('reads the skill id after /run', () => {
    expect(parseRunCommand('/run morning-brief')).toEqual({ ok: true, value: 'morning-brief' });
  });

  it('ignores surrounding whitespace and trailing words', () => {
    expect(parseRunCommand('  /run   morning-brief  now ')).toEqual({
      ok: true,
      value: 'morning-brief',
    });
  });

  it('rejects a missing skill id', () => {
    expect(parseRunCommand('/run')).toEqual({ ok: false, error: { kind: 'missing-skill-id' } });
    expect(parseRunCommand('/run   ')).toEqual({ ok: false, error: { kind: 'missing-skill-id' } });
  });

  it('rejects a skill id that is not a valid SkillId', () => {
    expect(parseRunCommand('/run ../escape')).toEqual({
      ok: false,
      error: {
        kind: 'invalid-skill-id',
        rawSkillId: '../escape',
        reason: 'SkillId must not contain path separators: ../escape',
      },
    });
  });
});

describe('findRunSkill', () => {
  const registry = skillRegistryFromList([skill('a'), skill('b')]);

  it('returns the registered skill', () => {
    expect(findRunSkill(registry, skillId('b'))).toEqual({ ok: true, value: skill('b') });
  });

  it('rejects an unknown skill and names every known one', () => {
    expect(findRunSkill(registry, skillId('zzz'))).toEqual({
      ok: false,
      error: { kind: 'unknown-skill', skillId: 'zzz', knownSkillIds: ['a', 'b'] },
    });
  });
});

describe('formatRunRejection', () => {
  it.each<[RunRejection, string]>([
    [{ kind: 'registry-unavailable' }, 'Skill registry not available — /run is disabled.'],
    [
      { kind: 'missing-skill-id' },
      'Usage: /run <skill-id>\nUse /status to see how many skills are loaded; check workspace/skills/ for IDs.',
    ],
    [{ kind: 'invalid-skill-id', rawSkillId: 'a/b', reason: 'bad' }, 'Invalid skill id "a/b": bad'],
    [
      { kind: 'unknown-skill', skillId: skillId('x'), knownSkillIds: [skillId('a'), skillId('b')] },
      'Unknown skill "x". Known: a, b',
    ],
  ])('formats %j', (rejection, reply) => {
    expect(formatRunRejection(rejection)).toBe(reply);
  });

  it('lists at most the first 20 known skills', () => {
    const known = Array.from({ length: 25 }, (_, i) => skillId(`s${i}`));
    const reply = formatRunRejection({
      kind: 'unknown-skill',
      skillId: skillId('x'),
      knownSkillIds: known,
    });
    expect(reply).toBe(`Unknown skill "x". Known: ${known.slice(0, 20).join(', ')}`);
    expect(reply).not.toContain('s20');
  });
});

describe('manualRunWindow', () => {
  it('triggers at whole seconds and stays valid for the skill window', () => {
    expect(manualRunWindow(new Date('2026-11-18T07:30:15.987Z'), 45)).toEqual({
      triggeredAt: '2026-11-18T07:30:15.000Z',
      validUntil: '2026-11-18T08:15:15.000Z',
    });
  });

  it('triggers within the second of now, and the window is exactly the validity minutes', () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date('2000-01-01T00:00:00.000Z'),
          max: new Date('2100-01-01T00:00:00.000Z'),
          noInvalidDate: true,
        }),
        fc.integer({ min: 1, max: 7 * 24 * 60 }),
        (now, minutes) => {
          const window = manualRunWindow(now, minutes);
          const triggered = Date.parse(window.triggeredAt);
          expect(triggered % 1000).toBe(0);
          expect(triggered).toBeLessThanOrEqual(now.getTime());
          expect(now.getTime() - triggered).toBeLessThan(1000);
          expect(Date.parse(window.validUntil) - triggered).toBe(minutes * 60_000);
        },
      ),
    );
  });
});
