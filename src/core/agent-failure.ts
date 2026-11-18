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
      /**
       * A subscription/plan usage window is used up ("You've hit your session limit · resets
       * 2:50pm", Codex "The usage limit has been reached"). Unlike a rate limit it does not
       * clear within a retry backoff — it resets hours later.
       */
      readonly kind: 'provider-quota-exhausted';
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

export const normalizeAgentFailureDetail = (detail: string): string => {
  const normalized = detail
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, '[REDACTED]')
    .replace(/(api[_ -]?key\s*[=:]\s*)\S+/gi, '$1[REDACTED]')
    .replace(/(bearer\s+)\S+/gi, '$1[REDACTED]');
  return (normalized === '' ? 'no diagnostic detail' : normalized).slice(0, 800);
};

/** The failure kinds a diagnostic's wording alone can establish. */
type DiagnosticKind = Extract<
  AgentFailure['kind'],
  | 'provider-quota-exhausted'
  | 'session-invalid'
  | 'provider-billing'
  | 'provider-rate-limited'
  | 'provider-authentication'
  | 'provider-unavailable'
  | 'configuration'
>;

type DiagnosticRule = Readonly<{
  kind: DiagnosticKind;
  matches: (lowerDetail: string) => boolean;
}>;

const mentionsAny =
  (fragments: readonly string[]) =>
  (lowerDetail: string): boolean =>
    fragments.some((fragment) => lowerDetail.includes(fragment));

const mentionsSession = mentionsAny(['session', 'conversation', 'resume']);
const invalidatesSession = mentionsAny([
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

/** Ordered: the first rule whose wording matches decides the kind. */
const DIAGNOSTIC_RULES: readonly DiagnosticRule[] = [
  // First: Claude's wording mentions "session" ("hit your session limit") and must never be
  // read as an invalid conversation session.
  {
    kind: 'provider-quota-exhausted',
    matches: mentionsAny(['hit your', 'usage limit', 'weekly limit', 'out of extra usage']),
  },
  {
    kind: 'session-invalid',
    matches: (lower) => mentionsSession(lower) && invalidatesSession(lower),
  },
  {
    kind: 'provider-billing',
    matches: mentionsAny([
      'credit balance',
      'insufficient credit',
      'billing limit',
      'payment required',
      'quota is permanently',
    ]),
  },
  {
    kind: 'provider-rate-limited',
    matches: mentionsAny([
      'rate limit',
      'rate_limit',
      'too many requests',
      '429',
      'quota exceeded',
      'resource exhausted',
    ]),
  },
  {
    kind: 'provider-authentication',
    matches: mentionsAny([
      'unauthorized',
      'authentication failed',
      'authentication error',
      'invalid api key',
      'invalid_api_key',
      'incorrect api key',
      'not authenticated',
      '401',
    ]),
  },
  {
    kind: 'provider-unavailable',
    matches: mentionsAny([
      'overloaded',
      'service unavailable',
      'temporarily unavailable',
      'connection refused',
      'connection reset',
      'connection error',
      'request timed out',
      'fetch failed',
      'econnrefused',
      'ehostunreach',
      'enginecore encountered',
      'network error',
      'bad gateway',
      'gateway timeout',
      '502',
      '503',
      '504',
    ]),
  },
  {
    kind: 'configuration',
    matches: mentionsAny([
      'unknown model',
      'model not found',
      'unknown provider',
      'provider not found',
      'missing api key',
      'command not found',
      'enoent',
    ]),
  },
];

/**
 * Classify diagnostics emitted by either backend. Unknown text stays explicit
 * and retryable; it never implies that discarding conversation state is safe.
 */
export function classifyAgentDiagnostic(backend: string, rawDetail: string): AgentFailure {
  const detail = normalizeAgentFailureDetail(rawDetail);
  const lower = detail.toLowerCase();
  const rule = DIAGNOSTIC_RULES.find((candidate) => candidate.matches(lower));
  return { kind: rule?.kind ?? 'backend-reported', backend, detail };
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
      { kind: 'provider-quota-exhausted' },
      { kind: 'provider-authentication' },
      { kind: 'provider-billing' },
      { kind: 'configuration' },
      { kind: 'protocol' },
      () => ({ retryable: false, mayRetryWithoutSession: false }),
    )
    .otherwise(() => ({ retryable: true, mayRetryWithoutSession: false }));
}

const QUOTA_EXHAUSTED_INFIX = ' usage quota is exhausted: ';

/**
 * Recover a quota-exhausted failure from its rendered message. A BullMQ dead letter carries
 * only the thrown message string, so this is the inverse of formatAgentFailure for that one
 * kind — kept beside the formatter so the two cannot drift.
 */
export function parseQuotaExhaustedMessage(
  message: string,
): { readonly backend: string; readonly detail: string } | null {
  const at = message.indexOf(QUOTA_EXHAUSTED_INFIX);
  if (at <= 0) return null;
  return {
    backend: message.slice(0, at),
    detail: message.slice(at + QUOTA_EXHAUSTED_INFIX.length),
  };
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
      { kind: 'provider-quota-exhausted' },
      (item) => `${item.backend}${QUOTA_EXHAUSTED_INFIX}${item.detail}`,
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
