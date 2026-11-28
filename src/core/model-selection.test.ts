import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  makeAgentTarget,
  makeClaudeModel,
  resolveModelSelection,
  scheduledModelSelections,
} from './model-selection.js';

const PI_DEFAULTS = { pi: { provider: 'desktop-vllm', model: 'glm-5.3-flash-qad2-tp2-v15:low' } };

describe('scheduledModelSelections', () => {
  it('replaces only the Pi model, keeping the provider', () => {
    expect(scheduledModelSelections(PI_DEFAULTS, 'claude-sonnet-5.5:medium')).toEqual({
      pi: { provider: 'desktop-vllm', model: 'claude-sonnet-5.5:medium' },
    });
  });

  it('is the chat defaults when no scheduled model is set', () => {
    expect(scheduledModelSelections(PI_DEFAULTS, undefined)).toBe(PI_DEFAULTS);
  });

  it('sets a Pi model even when no chat default exists', () => {
    expect(scheduledModelSelections({}, 'm')).toEqual({ pi: { model: 'm' } });
  });

  it('never touches the chat defaults and never reaches a Claude run', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (model) => {
        const scheduled = scheduledModelSelections(PI_DEFAULTS, model);
        expect(PI_DEFAULTS.pi.model).toBe('glm-5.3-flash-qad2-tp2-v15:low');
        expect(resolveModelSelection('pi', undefined, scheduled)?.model).toBe(model);
        expect(resolveModelSelection('pi', undefined, scheduled)?.provider).toBe('desktop-vllm');
        expect(resolveModelSelection('claude', undefined, scheduled)).toBeUndefined();
      }),
    );
  });
});

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

describe('makeAgentTarget', () => {
  it('takes a bare backend', () => {
    expect(makeAgentTarget('pi', undefined)).toEqual({ ok: true, value: { backend: 'pi' } });
    expect(makeAgentTarget('claude', undefined)).toEqual({
      ok: true,
      value: { backend: 'claude' },
    });
  });

  it('pins a Claude model', () => {
    expect(makeAgentTarget('claude', 'sonnet')).toEqual({
      ok: true,
      value: { backend: 'claude', model: 'sonnet' },
    });
  });

  it('refuses a model on Pi: its model is service-wide', () => {
    expect(makeAgentTarget('pi', 'glm')).toEqual({
      ok: false,
      error: { kind: 'model-needs-claude' },
    });
  });

  it('refuses a Claude model the CLI could read as a flag', () => {
    const target = makeAgentTarget('claude', '--dangerously-skip-permissions');
    expect(target.ok).toBe(false);
    if (!target.ok) expect(target.error.kind).toBe('invalid-claude-model');
  });

  it('accepts exactly the models makeClaudeModel accepts, and only on Claude', () => {
    fc.assert(
      fc.property(fc.constantFrom('claude' as const, 'pi' as const), fc.string(), (b, model) => {
        const target = makeAgentTarget(b, model);
        expect(target.ok).toBe(b === 'claude' && makeClaudeModel(model).ok);
      }),
    );
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
