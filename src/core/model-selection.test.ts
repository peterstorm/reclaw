import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { makeClaudeModel, resolveModelSelection } from './model-selection.js';

const PI_DEFAULTS = { pi: { provider: 'desktop-vllm', model: 'glm-5.3-flash-qad2-tp2-v15:low' } };

describe('resolveModelSelection', () => {
  it('applies the Pi service default to Pi runs', () => {
    expect(resolveModelSelection('pi', undefined, PI_DEFAULTS)).toEqual(PI_DEFAULTS.pi);
  });

  it('never leaks the Pi service default into a Claude run', () => {
    expect(resolveModelSelection('claude', undefined, PI_DEFAULTS)).toBeUndefined();
  });

  it('uses a requested Claude model on its own', () => {
    expect(resolveModelSelection('claude', { model: 'sonnet' }, PI_DEFAULTS)).toEqual({
      model: 'sonnet',
    });
  });

  it('lets a requested field override a default while keeping the others', () => {
    expect(resolveModelSelection('pi', { model: 'other' }, PI_DEFAULTS)).toEqual({
      provider: 'desktop-vllm',
      model: 'other',
    });
  });

  it('returns undefined (backend default) when nothing is configured or requested', () => {
    expect(resolveModelSelection('pi', undefined, {})).toBeUndefined();
    expect(resolveModelSelection('claude', undefined, {})).toBeUndefined();
  });
});

describe('makeClaudeModel', () => {
  it.each([
    'sonnet',
    'opus',
    'haiku',
    'opus[1m]',
    'claude-sonnet-5-5',
    'claude-haiku-4-5-20251001',
  ])('accepts %s', (raw) => {
    expect(makeClaudeModel(raw)).toEqual({ ok: true, value: raw });
  });

  it.each(['', '--dangerously-skip-permissions', '-m', 'sonnet extra', 'son;net', ' sonnet'])(
    'rejects %j',
    (raw) => {
      expect(makeClaudeModel(raw).ok).toBe(false);
    },
  );

  it('never accepts a value the CLI could parse as a flag or a second argument', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const parsed = makeClaudeModel(raw);
        if (parsed.ok) {
          expect(parsed.value.startsWith('-')).toBe(false);
          expect(/\s/.test(parsed.value)).toBe(false);
          expect(parsed.value.length).toBeGreaterThan(0);
        }
      }),
    );
  });
});
