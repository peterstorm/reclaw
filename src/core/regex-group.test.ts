import { describe, expect, it } from 'vitest';
import { defined } from './__fixtures__/defined.js';
import { requiredGroup } from './regex-group.js';

describe('requiredGroup', () => {
  it('returns a mandatory capture group', () => {
    const match = defined(/^(\w+)=(\d+)$/.exec('answer=42'), 'a match');
    expect(requiredGroup(match, 1)).toBe('answer');
    expect(requiredGroup(match, 2)).toBe('42');
  });

  it('returns an empty capture as the empty string, not as missing', () => {
    const match = defined(/^(\d*)x$/.exec('x'), 'a match');
    expect(requiredGroup(match, 1)).toBe('');
  });

  it('throws when the group did not participate in the match', () => {
    const match = defined(/^a(b)?$/.exec('a'), 'a match');
    expect(() => requiredGroup(match, 1)).toThrow(/capture group 1/);
  });
});
