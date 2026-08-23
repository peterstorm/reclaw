import { match } from 'ts-pattern';

/** Closed failure vocabulary for one agent subprocess invocation. */
export type AgentFailure =
  | {
      readonly kind: 'timeout';
      readonly backend: string;
      readonly timeoutMs: number;
    }
  | {
      readonly kind: 'session-invalid';
      readonly backend: string;
      readonly detail: string;
    }
  | {
      readonly kind: 'provider-rate-limited';
      readonly backend: string;
      readonly detail: string;
    }
  | {
      readonly kind: 'provider-unavailable';
      readonly backend: string;
      readonly detail: string;
    }
  | {
      readonly kind: 'provider-authentication';
      readonly backend: string;
      readonly detail: string;
    }
  | {
      readonly kind: 'provider-billing';
      readonly backend: string;
      readonly detail: string;
    }
  | {
      readonly kind: 'configuration';
      readonly backend: string;
      readonly detail: string;
    }
  | {
      readonly kind: 'spawn';
      readonly backend: string;
      readonly detail: string;
    }
  | {
      readonly kind: 'input-write';
      readonly backend: string;
      readonly detail: string;
    }
  | {
      readonly kind: 'output-read';
      readonly backend: string;
      readonly detail: string;
    }
  | {
      readonly kind: 'process-exit';
      readonly backend: string;
      readonly exitCode: number;
      readonly detail: string;
    }
  | {
      readonly kind: 'protocol';
      readonly backend: string;
      readonly detail: string;
    }
  | {
      readonly kind: 'backend-reported';
      readonly backend: string;
      readonly detail: string;
    };

export type AgentFailurePolicy = {
  readonly retryable: boolean;
  readonly mayRetryWithoutSession: boolean;
};

const includesAny = (value: string, fragments: readonly string[]): boolean =>
  fragments.some((fragment) => value.includes(fragment));

export const normalizeAgentFailureDetail = (detail: string): string => {
  const normalized = detail
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, '[REDACTED]')
    .replace(/(api[_ -]?key\s*[=:]\s*)\S+/gi, '$1[REDACTED]')
    .replace(/(bearer\s+)\S+/gi, '$1[REDACTED]');
  return (normalized === '' ? 'no diagnostic detail' : normalized).slice(0, 800);
};

/**
 * Classify diagnostics emitted by either backend. Unknown text stays explicit
 * and retryable; it never implies that discarding conversation state is safe.
 */
export function classifyAgentDiagnostic(backend: string, rawDetail: string): AgentFailure {
  const detail = normalizeAgentFailureDetail(rawDetail);
  const lower = detail.toLowerCase();

  const mentionsSession = includesAny(lower, ['session', 'conversation', 'resume']);
  const invalidatesSession = includesAny(lower, [
    'not found',
    'no conversation found',
    'no session found',
    'does not exist',
    'invalid',
    'expired',
    'unknown',
    'failed to resume',
    'cannot resume',
    "can't resume",
  ]);
  if (mentionsSession && invalidatesSession) {
    return { kind: 'session-invalid', backend, detail };
  }

  if (
    includesAny(lower, [
      'credit balance',
      'insufficient credit',
      'billing limit',
      'payment required',
      'quota is permanently',
    ])
  ) {
    return { kind: 'provider-billing', backend, detail };
  }

  if (
    includesAny(lower, [
      'rate limit',
      'rate_limit',
      'too many requests',
      '429',
      'quota exceeded',
      'resource exhausted',
    ])
  ) {
    return { kind: 'provider-rate-limited', backend, detail };
  }

  if (
    includesAny(lower, [
      'unauthorized',
      'authentication failed',
      'authentication error',
      'invalid api key',
      'invalid_api_key',
      'incorrect api key',
      'not authenticated',
      '401',
    ])
  ) {
    return { kind: 'provider-authentication', backend, detail };
  }

  if (
    includesAny(lower, [
      'overloaded',
      'service unavailable',
      'temporarily unavailable',
      'connection refused',
      'connection reset',
      'network error',
      'bad gateway',
      'gateway timeout',
      '502',
      '503',
      '504',
    ])
  ) {
    return { kind: 'provider-unavailable', backend, detail };
  }

  if (
    includesAny(lower, [
      'unknown model',
      'model not found',
      'unknown provider',
      'provider not found',
      'missing api key',
      'command not found',
      'enoent',
    ])
  ) {
    return { kind: 'configuration', backend, detail };
  }

  return { kind: 'backend-reported', backend, detail };
}

/** Unknown nonzero exits retain process metadata unless their detail is classifiable. */
export function classifyAgentExit(
  backend: string,
  exitCode: number,
  rawDetail: string,
): AgentFailure {
  const classified = classifyAgentDiagnostic(backend, rawDetail);
  return classified.kind === 'backend-reported'
    ? { kind: 'process-exit', backend, exitCode, detail: classified.detail }
    : classified;
}

/** Pure retry and session-discard policy. */
export function agentFailurePolicy(failure: AgentFailure): AgentFailurePolicy {
  return match(failure)
    .with({ kind: 'session-invalid' }, () => ({
      retryable: false,
      mayRetryWithoutSession: true,
    }))
    .with(
      { kind: 'provider-authentication' },
      { kind: 'provider-billing' },
      { kind: 'configuration' },
      { kind: 'protocol' },
      () => ({ retryable: false, mayRetryWithoutSession: false }),
    )
    .otherwise(() => ({ retryable: true, mayRetryWithoutSession: false }));
}

/** Stable diagnostic rendering for logs, quality records, and dead letters. */
export function formatAgentFailure(failure: AgentFailure): string {
  return match(failure)
    .with({ kind: 'timeout' }, (item) => `${item.backend} timed out after ${item.timeoutMs}ms`)
    .with(
      { kind: 'session-invalid' },
      (item) => `${item.backend} session is invalid: ${item.detail}`,
    )
    .with(
      { kind: 'provider-rate-limited' },
      (item) => `${item.backend} provider rate limited the request: ${item.detail}`,
    )
    .with(
      { kind: 'provider-unavailable' },
      (item) => `${item.backend} provider is unavailable: ${item.detail}`,
    )
    .with(
      { kind: 'provider-authentication' },
      (item) => `${item.backend} provider authentication failed: ${item.detail}`,
    )
    .with(
      { kind: 'provider-billing' },
      (item) => `${item.backend} provider billing rejected the request: ${item.detail}`,
    )
    .with(
      { kind: 'configuration' },
      (item) => `${item.backend} configuration is invalid: ${item.detail}`,
    )
    .with({ kind: 'spawn' }, (item) => `Failed to spawn ${item.backend}: ${item.detail}`)
    .with({ kind: 'input-write' }, (item) => `${item.backend} stdin write failed: ${item.detail}`)
    .with({ kind: 'output-read' }, (item) => `${item.backend} stdout read failed: ${item.detail}`)
    .with(
      { kind: 'process-exit' },
      (item) => `${item.backend} exited with code ${item.exitCode}: ${item.detail}`,
    )
    .with({ kind: 'protocol' }, (item) => `${item.backend} protocol error: ${item.detail}`)
    .with({ kind: 'backend-reported' }, (item) => `${item.backend} agent error: ${item.detail}`)
    .exhaustive();
}
