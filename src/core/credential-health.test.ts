import { describe, expect, it } from 'vitest';
import {
  MS_PER_DAY,
  MS_PER_HOUR,
  type NotebookLMSource,
  type Probe,
  classifyOAuthExpiry,
  decideGarminRepair,
  decideNotebookLMRepair,
  formatDuration,
  parseClaudeCredentials,
  renderReport,
  resolveNotebookLMSource,
} from './credential-health.js';

const NOW = Date.UTC(2026, 7, 9, 12, 0, 0);

const credsJson = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ authToken: 'SNlM0e-token', cookies: 'SID=abc; HSID=def', ...over });

describe('formatDuration', () => {
  it('picks a single coarse unit', () => {
    expect(formatDuration(3 * MS_PER_DAY)).toBe('3 days');
    expect(formatDuration(5 * MS_PER_HOUR)).toBe('5 hours');
    expect(formatDuration(12 * 60_000)).toBe('12 minutes');
  });

  it('uses singular forms at exactly one unit', () => {
    expect(formatDuration(MS_PER_DAY)).toBe('1 day');
    expect(formatDuration(MS_PER_HOUR)).toBe('1 hour');
    expect(formatDuration(60_000)).toBe('1 minute');
  });

  it('floors rather than rounds up, so a warning never overstates time left', () => {
    expect(formatDuration(1.9 * MS_PER_DAY)).toBe('1 day');
  });

  it('clamps negatives to zero — callers phrase the direction', () => {
    expect(formatDuration(-5 * MS_PER_DAY)).toBe('0 minutes');
  });
});

describe('resolveNotebookLMSource', () => {
  it('prefers env vars over credentials.json, matching the SDK priority order', () => {
    const source = resolveNotebookLMSource(
      { NOTEBOOKLM_AUTH_TOKEN: 'env-token', NOTEBOOKLM_COOKIES: 'env-cookies' },
      { content: credsJson(), mtimeMs: NOW },
      NOW,
    );
    expect(source).toEqual({
      kind: 'token',
      origin: 'env',
      authToken: 'env-token',
      cookies: 'env-cookies',
      ageDays: null,
    });
  });

  it('ignores a half-configured env pair and falls through to the file', () => {
    const source = resolveNotebookLMSource(
      { NOTEBOOKLM_AUTH_TOKEN: 'env-token' },
      { content: credsJson(), mtimeMs: NOW - 2 * MS_PER_DAY },
      NOW,
    );
    expect(source.kind).toBe('token');
    if (source.kind === 'token') {
      expect(source.origin).toBe('file');
      expect(source.authToken).toBe('SNlM0e-token');
      expect(source.ageDays).toBeCloseTo(2);
    }
  });

  it('reports the file age in days', () => {
    const source = resolveNotebookLMSource(
      {},
      { content: credsJson(), mtimeMs: NOW - 55 * MS_PER_DAY },
      NOW,
    );
    expect(source.kind === 'token' && source.ageDays).toBeCloseTo(55);
  });

  it('never returns a negative age when the file mtime is in the future', () => {
    const source = resolveNotebookLMSource(
      {},
      { content: credsJson(), mtimeMs: NOW + MS_PER_DAY },
      NOW,
    );
    expect(source.kind === 'token' && source.ageDays).toBe(0);
  });

  it.each([
    ['missing file', null, 'no credentials.json'],
    ['unparseable file', { content: 'not json', mtimeMs: NOW }, 'not valid JSON'],
    ['non-object file', { content: '"a string"', mtimeMs: NOW }, 'not a JSON object'],
    ['no authToken', { content: JSON.stringify({ cookies: 'c' }), mtimeMs: NOW }, 'no authToken'],
    ['empty authToken', { content: credsJson({ authToken: '' }), mtimeMs: NOW }, 'no authToken'],
    ['no cookies', { content: JSON.stringify({ authToken: 't' }), mtimeMs: NOW }, 'no cookies'],
    ['empty cookies', { content: credsJson({ cookies: '' }), mtimeMs: NOW }, 'no cookies'],
  ])('reports %s as absent with a reason', (_label, file, expected) => {
    const source = resolveNotebookLMSource({}, file, NOW);
    expect(source.kind).toBe('absent');
    if (source.kind === 'absent') expect(source.reason).toContain(expected);
  });
});

describe('decideNotebookLMRepair', () => {
  const fileSource = (ageDays: number): NotebookLMSource => ({
    kind: 'token',
    origin: 'file',
    authToken: 't',
    cookies: 'c',
    ageDays,
  });
  const envSource: NotebookLMSource = {
    kind: 'token',
    origin: 'env',
    authToken: 't',
    cookies: 'c',
    ageDays: null,
  };
  const base = {
    staleAfterDays: 20,
    lastAttemptMs: null,
    cooldownMs: 6 * MS_PER_HOUR,
    nowMs: NOW,
  } as const;

  it('skips a healthy, fresh credential', () => {
    const decision = decideNotebookLMRepair({ ...base, source: fileSource(3), probe: 'ok' });
    expect(decision.kind).toBe('skip');
  });

  it('attempts when the probe failed', () => {
    const decision = decideNotebookLMRepair({ ...base, source: fileSource(3), probe: 'failed' });
    expect(decision).toEqual({ kind: 'attempt', reason: 'the auth probe failed' });
  });

  it('attempts on age alone, before the probe ever fails', () => {
    const decision = decideNotebookLMRepair({ ...base, source: fileSource(21), probe: 'ok' });
    expect(decision.kind).toBe('attempt');
    if (decision.kind === 'attempt') expect(decision.reason).toContain('21 days old');
  });

  it('treats the staleness threshold as inclusive', () => {
    expect(decideNotebookLMRepair({ ...base, source: fileSource(20), probe: 'ok' }).kind).toBe(
      'attempt',
    );
    expect(decideNotebookLMRepair({ ...base, source: fileSource(19.9), probe: 'ok' }).kind).toBe(
      'skip',
    );
  });

  it('attempts when there is no credential at all', () => {
    const decision = decideNotebookLMRepair({
      ...base,
      source: { kind: 'absent', reason: 'no credentials.json and no NOTEBOOKLM_* env vars' },
      probe: 'not-run',
    });
    expect(decision.kind).toBe('attempt');
    if (decision.kind === 'attempt') expect(decision.reason).toContain('no usable credential');
  });

  it('refuses to repair env-provided credentials, because re-auth cannot fix them', () => {
    const decision = decideNotebookLMRepair({ ...base, source: envSource, probe: 'failed' });
    expect(decision.kind).toBe('skip');
    if (decision.kind === 'skip') expect(decision.reason).toContain('override credentials.json');
  });

  it('honours the cooldown so a repeated /run cannot hammer Google login', () => {
    const decision = decideNotebookLMRepair({
      ...base,
      source: fileSource(3),
      probe: 'failed',
      lastAttemptMs: NOW - MS_PER_HOUR,
    });
    expect(decision.kind).toBe('skip');
    if (decision.kind === 'skip') expect(decision.reason).toContain('cooling down');
  });

  it('attempts again once the cooldown has elapsed', () => {
    const decision = decideNotebookLMRepair({
      ...base,
      source: fileSource(3),
      probe: 'failed',
      lastAttemptMs: NOW - 7 * MS_PER_HOUR,
    });
    expect(decision.kind).toBe('attempt');
  });
});

describe('decideGarminRepair', () => {
  const base = {
    lastAttemptMs: null,
    cooldownMs: 6 * MS_PER_HOUR,
    nowMs: NOW,
  } as const;

  it('does nothing while the cached tokens work — the daily sync owns this credential', () => {
    expect(decideGarminRepair({ ...base, probe: 'ok' })).toEqual({
      kind: 'skip',
      reason: 'cached tokens are valid',
    });
  });

  it('attempts a login when the cached tokens are rejected', () => {
    const decision = decideGarminRepair({ ...base, probe: 'failed' });
    expect(decision).toEqual({ kind: 'attempt', reason: 'cached tokens were rejected by Garmin' });
  });

  it('attempts a login when there are no cached tokens at all', () => {
    expect(decideGarminRepair({ ...base, probe: 'no-tokens' }).kind).toBe('attempt');
  });

  it('honours the cooldown so a bad password cannot drive repeated login attempts', () => {
    const decision = decideGarminRepair({ ...base, probe: 'failed', lastAttemptMs: NOW - 60_000 });
    expect(decision.kind).toBe('skip');
    if (decision.kind === 'skip') expect(decision.reason).toContain('cooling down');
  });
});

describe('classifyOAuthExpiry', () => {
  const base = { warnWithinMs: 7 * MS_PER_DAY, remedy: 're-authenticate', nowMs: NOW } as const;

  it('is healthy when the refresh token has plenty of life', () => {
    const outcome = classifyOAuthExpiry({
      ...base,
      expiry: { accessExpiresAtMs: NOW + MS_PER_HOUR, refreshExpiresAtMs: NOW + 30 * MS_PER_DAY },
    });
    expect(outcome.kind).toBe('healthy');
  });

  it('stays healthy when the access token is already expired but the refresh token is live', () => {
    const outcome = classifyOAuthExpiry({
      ...base,
      expiry: { accessExpiresAtMs: NOW - MS_PER_HOUR, refreshExpiresAtMs: NOW + 30 * MS_PER_DAY },
    });
    expect(outcome.kind).toBe('healthy');
  });

  it('warns inside the window on the refresh token', () => {
    const outcome = classifyOAuthExpiry({
      ...base,
      expiry: { accessExpiresAtMs: NOW + MS_PER_HOUR, refreshExpiresAtMs: NOW + 2 * MS_PER_DAY },
    });
    expect(outcome.kind).toBe('expiring');
    if (outcome.kind === 'expiring') {
      expect(outcome.detail).toContain('2 days');
      expect(outcome.remedy).toBe('re-authenticate');
    }
  });

  it('breaks once the refresh token is past — this is the 2026-07-20 outage', () => {
    const outcome = classifyOAuthExpiry({
      ...base,
      expiry: { accessExpiresAtMs: NOW - MS_PER_DAY, refreshExpiresAtMs: NOW - MS_PER_DAY },
    });
    expect(outcome.kind).toBe('broken');
    if (outcome.kind === 'broken') expect(outcome.detail).toContain('cannot renew itself');
  });

  it('falls back to the access token when no refresh expiry is recorded (the Pi store)', () => {
    expect(
      classifyOAuthExpiry({
        ...base,
        expiry: { accessExpiresAtMs: NOW + 30 * MS_PER_DAY, refreshExpiresAtMs: null },
      }).kind,
    ).toBe('healthy');
    expect(
      classifyOAuthExpiry({
        ...base,
        expiry: { accessExpiresAtMs: NOW - 60_000, refreshExpiresAtMs: null },
      }).kind,
    ).toBe('broken');
  });

  it('reports unknown — never healthy — when the store records no expiry at all', () => {
    const outcome = classifyOAuthExpiry({
      ...base,
      expiry: { accessExpiresAtMs: null, refreshExpiresAtMs: null },
    });
    expect(outcome.kind).toBe('unknown');
  });
});

describe('parseClaudeCredentials', () => {
  it('extracts both expiries', () => {
    const content = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'a',
        refreshToken: 'r',
        expiresAt: 1000,
        refreshTokenExpiresAt: 2000,
      },
    });
    expect(parseClaudeCredentials(content)).toEqual({
      accessExpiresAtMs: 1000,
      refreshExpiresAtMs: 2000,
    });
  });

  it('nulls out fields of the wrong type rather than trusting them', () => {
    const content = JSON.stringify({
      claudeAiOauth: { expiresAt: '1000', refreshTokenExpiresAt: 2000 },
    });
    expect(parseClaudeCredentials(content)).toEqual({
      accessExpiresAtMs: null,
      refreshExpiresAtMs: 2000,
    });
  });

  it.each(['not json', '"a string"', '{}', JSON.stringify({ claudeAiOauth: null })])(
    'returns null for unusable store %j',
    (content) => {
      expect(parseClaudeCredentials(content)).toBeNull();
    },
  );
});

describe('renderReport', () => {
  const healthy: Probe = { id: 'garmin', outcome: { kind: 'healthy', detail: 'fine' } };
  const broken: Probe = {
    id: 'notebooklm',
    outcome: { kind: 'broken', detail: 'auth probe failed', remedy: 'run the re-auth script' },
  };
  const expiring: Probe = {
    id: 'agent-claude',
    outcome: { kind: 'expiring', detail: 'expires in 2 days', remedy: 'claude /login' },
  };
  const repaired: Probe = {
    id: 'notebooklm',
    outcome: { kind: 'repaired', detail: 'refreshed after a failed probe' },
  };
  const unknown: Probe = {
    id: 'agent-pi',
    outcome: { kind: 'unknown', detail: 'pi binary not found' },
  };

  it('goes all-clear when every probe is healthy', () => {
    expect(renderReport([healthy, { ...healthy, id: 'notebooklm' }])).toEqual({
      kind: 'all-clear',
    });
  });

  it('alerts when nothing was probed — silence must mean "checked and fine"', () => {
    const report = renderReport([]);
    expect(report.kind).toBe('alert');
    if (report.kind === 'alert') expect(report.message).toContain('probed nothing');
  });

  it('reports a repair even though it needs no action', () => {
    const report = renderReport([repaired, healthy]);
    expect(report.kind).toBe('alert');
    if (report.kind === 'alert') {
      expect(report.message).toContain('NotebookLM');
      expect(report.message).toContain('refreshed after a failed probe');
      expect(report.message).not.toContain('→');
    }
  });

  it('orders lines by severity and attaches remedies only where there is action', () => {
    const report = renderReport([repaired, unknown, expiring, broken, healthy]);
    expect(report.kind).toBe('alert');
    if (report.kind !== 'alert') return;
    // Icons differ in UTF-16 width (⚪ is one code unit, the rest are surrogate
    // pairs), so match by prefix rather than slicing a fixed number of units.
    const icons = ['🔴', '🟡', '⚪', '🔧'] as const;
    const order = report.message
      .split('\n')
      .flatMap((line) => icons.filter((icon) => line.startsWith(icon)));
    expect(order).toEqual(['🔴', '🟡', '⚪', '🔧']);
    expect(report.message).toContain('→ run the re-auth script');
    expect(report.message).toContain('→ claude /login');
  });

  it('omits healthy credentials from the message entirely', () => {
    const report = renderReport([broken, healthy]);
    expect(report.kind).toBe('alert');
    if (report.kind === 'alert') expect(report.message).not.toContain('Garmin');
  });
});
