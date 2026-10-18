import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type AgentFailure,
  agentFailurePolicy,
  classifyAgentDiagnostic,
  classifyAgentExit,
  formatAgentFailure,
  parseQuotaExhaustedMessage,
} from './agent-failure.js';

describe('classifyAgentDiagnostic', () => {
  it.each([
    ['No conversation found with session ID abc', 'session-invalid'],
    ['session not found', 'session-invalid'],
    ['429 quota exceeded', 'provider-rate-limited'],
    ['rate_limit_error', 'provider-rate-limited'],
    ['Credit balance is too low', 'provider-billing'],
    ['invalid API key', 'provider-authentication'],
    ['overloaded_error', 'provider-unavailable'],
    ['503 service unavailable', 'provider-unavailable'],
    ['unknown model deepseek-future', 'configuration'],
    ['unrecognized backend failure', 'backend-reported'],
    // Real diagnostics from Reclaw logs/transcripts. Claude's says "session" but is a quota,
    // never an invalid conversation session.
    [
      "You've hit your session limit · resets 2:50pm (Europe/Copenhagen)",
      'provider-quota-exhausted',
    ],
    ["You've hit your weekly limit · resets Oct 21, 9am", 'provider-quota-exhausted'],
    ['Codex error: The usage limit has been reached', 'provider-quota-exhausted'],
    ['Connection error.', 'provider-unavailable'],
    ['Request timed out.', 'provider-unavailable'],
    [
      'EngineCore encountered an issue. See stack trace (above) for the root cause.',
      'provider-unavailable',
    ],
  ] as const)('classifies %j as %s', (detail, expected) => {
    expect(classifyAgentDiagnostic('pi', detail).kind).toBe(expected);
  });

  it('normalizes, redacts, and bounds untrusted diagnostics', () => {
    const result = classifyAgentDiagnostic(
      'pi',
      `  unknown api_key=secret-value bearer abc.def sk-1234567890 ${'x'.repeat(1_000)}  `,
    );
    expect(result.kind).toBe('backend-reported');
    if (result.kind !== 'backend-reported') throw new Error('unexpected fixture classification');
    expect(result.detail.length).toBe(800);
    expect(result.detail).not.toContain('  ');
    expect(result.detail).not.toContain('secret-value');
    expect(result.detail).not.toContain('abc.def');
    expect(result.detail).not.toContain('sk-1234567890');
  });
});

describe('classifyAgentExit', () => {
  it('retains exit metadata for an unknown process failure', () => {
    expect(classifyAgentExit('claude', 7, 'segmentation fault')).toEqual({
      kind: 'process-exit',
      backend: 'claude',
      exitCode: 7,
      detail: 'segmentation fault',
    });
  });

  it('promotes a provider diagnostic over the transport exit', () => {
    expect(classifyAgentExit('claude', 1, 'overloaded_error')).toMatchObject({
      kind: 'provider-unavailable',
    });
  });
});

describe('agentFailurePolicy', () => {
  const failure = (kind: AgentFailure['kind']): AgentFailure => {
    if (kind === 'timeout') return { kind, backend: 'pi', timeoutMs: 1_000 };
    if (kind === 'process-exit') {
      return { kind, backend: 'pi', exitCode: 1, detail: 'failure' };
    }
    return { kind, backend: 'pi', detail: 'failure' };
  };

  it.each([
    ['timeout', true, false],
    ['provider-rate-limited', true, false],
    ['provider-unavailable', true, false],
    ['spawn', true, false],
    ['input-write', true, false],
    ['output-read', true, false],
    ['process-exit', true, false],
    ['backend-reported', true, false],
    // A spent usage window resets hours later; BullMQ's minute-scale backoff cannot outlast it.
    ['provider-quota-exhausted', false, false],
    ['provider-authentication', false, false],
    ['provider-billing', false, false],
    ['configuration', false, false],
    ['protocol', false, false],
    ['session-invalid', false, true],
  ] as const)('%s has retryable=%s and fresh-session=%s', (kind, retryable, fresh) => {
    expect(agentFailurePolicy(failure(kind))).toEqual({
      retryable,
      mayRetryWithoutSession: fresh,
    });
  });
});

describe('parseQuotaExhaustedMessage', () => {
  it('inverts formatAgentFailure for a quota failure', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('claude', 'pi'),
        fc.string({ minLength: 1 }),
        (backend, detail) => {
          const message = formatAgentFailure({ kind: 'provider-quota-exhausted', backend, detail });
          expect(parseQuotaExhaustedMessage(message)).toEqual({ backend, detail });
        },
      ),
    );
  });

  it('returns null for every other rendered failure', () => {
    expect(
      parseQuotaExhaustedMessage(
        formatAgentFailure({ kind: 'provider-rate-limited', backend: 'claude', detail: '429' }),
      ),
    ).toBeNull();
    expect(parseQuotaExhaustedMessage('Claude crashed')).toBeNull();
  });
});

describe('formatAgentFailure', () => {
  it('renders stable timeout diagnostics', () => {
    expect(formatAgentFailure({ kind: 'timeout', backend: 'pi', timeoutMs: 30_000 })).toBe(
      'pi timed out after 30000ms',
    );
  });

  it('includes process exit metadata', () => {
    expect(
      formatAgentFailure({
        kind: 'process-exit',
        backend: 'claude',
        exitCode: 9,
        detail: 'killed',
      }),
    ).toBe('claude exited with code 9: killed');
  });
});
