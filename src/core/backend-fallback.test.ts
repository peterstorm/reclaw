import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { AgentFailure } from './agent-failure.js';
import { backendCannotServe, fallbackNotice, planFallback } from './backend-fallback.js';
import type { AgentTarget, ClaudeModel } from './model-selection.js';

const failure = (kind: AgentFailure['kind'], backend = 'claude'): AgentFailure => {
  if (kind === 'timeout') return { kind, backend, timeoutMs: 1_000 };
  if (kind === 'process-exit') return { kind, backend, exitCode: 1, detail: 'failure' };
  return { kind, backend, detail: 'failure' };
};

const ALL_KINDS: readonly (readonly [AgentFailure['kind'], boolean])[] = [
  ['provider-quota-exhausted', true],
  ['provider-rate-limited', true],
  ['provider-unavailable', true],
  ['provider-authentication', true],
  ['provider-billing', true],
  ['spawn', true],
  ['timeout', false],
  ['session-invalid', false],
  ['configuration', false],
  ['input-write', false],
  ['output-read', false],
  ['process-exit', false],
  ['protocol', false],
  ['backend-reported', false],
];

const PI: AgentTarget = { backend: 'pi' };
const SONNET: AgentTarget = { backend: 'claude', model: 'sonnet' as ClaudeModel };

describe('backendCannotServe', () => {
  it.each(ALL_KINDS)('%s → %s', (kind, expected) => {
    expect(backendCannotServe(failure(kind))).toBe(expected);
  });
});

describe('planFallback', () => {
  it('falls back to Pi when Claude is out of usage', () => {
    expect(planFallback('claude', PI, failure('provider-quota-exhausted'))).toEqual(PI);
  });

  it('falls back to Claude (with its pinned model) when vLLM is unreachable', () => {
    expect(planFallback('pi', SONNET, failure('provider-unavailable', 'pi'))).toEqual(SONNET);
  });

  it('keeps a task failure — rerunning it elsewhere would most likely repeat it', () => {
    expect(planFallback('claude', PI, failure('timeout'))).toBeNull();
    expect(planFallback('claude', PI, failure('backend-reported'))).toBeNull();
  });

  it('does nothing without a configured fallback', () => {
    expect(planFallback('claude', undefined, failure('provider-quota-exhausted'))).toBeNull();
  });

  it('never "falls back" to the backend that just failed', () => {
    const targets = fc.constantFrom<AgentTarget>(PI, SONNET, { backend: 'claude' });
    fc.assert(
      fc.property(
        fc.constantFrom('claude' as const, 'pi' as const),
        fc.option(targets, { nil: undefined }),
        fc.constantFrom(...ALL_KINDS.map(([kind]) => kind)),
        (primary, fallback, kind) => {
          const plan = planFallback(primary, fallback, failure(kind, primary));
          if (plan !== null) {
            expect(plan.backend).not.toBe(primary);
            expect(plan).toBe(fallback);
            expect(backendCannotServe(failure(kind))).toBe(true);
          }
        },
      ),
    );
  });
});

describe('fallbackNotice', () => {
  it('names the backend used and why', () => {
    const notice = fallbackNotice(
      {
        kind: 'provider-quota-exhausted',
        backend: 'claude',
        detail: "You've hit your session limit · resets 2:50pm",
      },
      PI,
    );
    expect(notice).toBe(
      "⚠️ Fallback: ran on pi — claude usage quota is exhausted: You've hit your session limit · resets 2:50pm",
    );
  });

  it('bounds a long diagnostic to one short line', () => {
    const notice = fallbackNotice(
      { kind: 'provider-unavailable', backend: 'pi', detail: 'x'.repeat(2_000) },
      SONNET,
    );
    expect(notice.length).toBeLessThan(200);
    expect(notice).not.toContain('\n');
    expect(notice.endsWith('…')).toBe(true);
  });
});
