import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MS_PER_DAY,
  MS_PER_HOUR,
  type NotebookLMProbeRun,
  type NotebookLMSource,
  type Probe,
  REAUTH_COMMAND,
  type RepairDecision,
  classifyApiKeyProbe,
  classifyOAuthExpiry,
  decideGarminRepair,
  decideNotebookLMRepair,
  formatDuration,
  lastRepairAttemptMs,
  parseClaudeCredentials,
  planGarminCheck,
  planNotebookLMCheck,
  renderReport,
  resolveNotebookLMSource,
  resolvePiProviderAuth,
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

describe('planNotebookLMCheck', () => {
  const fileSource: NotebookLMSource = {
    kind: 'token',
    origin: 'file',
    authToken: 't',
    cookies: 'c',
    ageDays: 3.7,
  };
  const envSource: NotebookLMSource = { ...fileSource, origin: 'env', ageDays: null };
  const skip = (reason: string): RepairDecision => ({ kind: 'skip', reason });
  const attempt = (reason: string): RepairDecision => ({ kind: 'attempt', reason });

  it('reports a skipped, passing probe as healthy, naming where the credential comes from', () => {
    const ok = { result: 'ok' } as const;
    expect(
      planNotebookLMCheck({ source: fileSource, run: ok, decision: skip('fresh'), dryRun: false }),
    ).toEqual({
      kind: 'report',
      outcome: { kind: 'healthy', detail: 'credentials.json is 3 days old' },
    });
    expect(
      planNotebookLMCheck({ source: envSource, run: ok, decision: skip('fresh'), dryRun: false }),
    ).toEqual({
      kind: 'report',
      outcome: { kind: 'healthy', detail: 'credentials come from the environment' },
    });
  });

  it('gives an env-provided credential the re-issue remedy, with the probe’s own error', () => {
    const plan = planNotebookLMCheck({
      source: envSource,
      run: { result: 'failed', error: '401 from notebooks.list' },
      decision: skip('env vars override credentials.json'),
      dryRun: false,
    });
    expect(plan).toEqual({
      kind: 'report',
      outcome: {
        kind: 'broken',
        detail: '401 from notebooks.list',
        remedy:
          're-issue the NOTEBOOKLM_AUTH_TOKEN / NOTEBOOKLM_COOKIES secrets — they take priority over credentials.json',
      },
    });
  });

  it('explains a fault the cooldown skipped by the decision’s reason when the probe has no error', () => {
    const plan = planNotebookLMCheck({
      source: { kind: 'absent', reason: 'no credentials.json' },
      run: { result: 'not-run' },
      decision: skip('no usable credential, but cooling down'),
      dryRun: false,
    });
    expect(plan).toEqual({
      kind: 'report',
      outcome: {
        kind: 'broken',
        detail: 'no usable credential, but cooling down',
        remedy: `run ${REAUTH_COMMAND} to retry now`,
      },
    });
    const emptyError = planNotebookLMCheck({
      source: fileSource,
      run: { result: 'failed', error: '' },
      decision: skip('cooling down'),
      dryRun: false,
    });
    expect(emptyError).toMatchObject({ outcome: { detail: 'cooling down' } });
  });

  it('reports the repair a dry run skipped: expiring while the probe passes, broken once it does not', () => {
    const dryRun = (run: NotebookLMProbeRun) =>
      planNotebookLMCheck({
        source: fileSource,
        run,
        decision: attempt('21 days old'),
        dryRun: true,
      });
    expect(dryRun({ result: 'ok' })).toEqual({
      kind: 'report',
      outcome: {
        kind: 'expiring',
        detail: '21 days old (repair skipped: --dry-run)',
        remedy: `run ${REAUTH_COMMAND}`,
      },
    });
    expect(dryRun({ result: 'failed', error: 'x' })).toMatchObject({
      outcome: { kind: 'broken' },
    });
  });

  it('repairs exactly when the decision attempts and the run is not a dry run', () => {
    const sources = fc.constantFrom<NotebookLMSource>(fileSource, envSource, {
      kind: 'absent',
      reason: 'none',
    });
    const runs = fc.constantFrom<NotebookLMProbeRun>(
      { result: 'ok' },
      { result: 'not-run' },
      { result: 'failed', error: 'boom' },
    );
    const decisions = fc.record({
      kind: fc.constantFrom('attempt' as const, 'skip' as const),
      reason: fc.string(),
    });
    fc.assert(
      fc.property(sources, runs, decisions, fc.boolean(), (source, run, decision, dryRun) => {
        const plan = planNotebookLMCheck({ source, run, decision, dryRun });
        expect(plan.kind === 'repair').toBe(decision.kind === 'attempt' && !dryRun);
        if (plan.kind === 'repair') expect(plan.reason).toBe(decision.reason);
        // A credential this check would have repaired is never reported healthy.
        if (decision.kind === 'attempt' && plan.kind === 'report') {
          expect(plan.outcome.kind).not.toBe('healthy');
        }
      }),
    );
  });
});

describe('planGarminCheck', () => {
  it('reports skipped, accepted tokens as healthy', () => {
    expect(
      planGarminCheck({
        run: { result: 'ok' },
        decision: { kind: 'skip', reason: 'cached tokens are valid' },
        dryRun: false,
      }),
    ).toEqual({
      kind: 'report',
      outcome: { kind: 'healthy', detail: 'cached tokens accepted by Garmin' },
    });
  });

  it('reports rejected tokens the cooldown skipped as broken, leaving the login to garmin-sync', () => {
    const reason = 'cached tokens were rejected by Garmin, but cooling down';
    const decision = { kind: 'skip', reason } as const;
    expect(
      planGarminCheck({ run: { result: 'failed', error: '401' }, decision, dryRun: false }),
    ).toEqual({
      kind: 'report',
      outcome: {
        kind: 'broken',
        detail: '401',
        remedy: `${reason} — the 20:00 garmin-sync will retry the login`,
      },
    });
    expect(
      planGarminCheck({ run: { result: 'no-tokens' }, decision, dryRun: false }),
    ).toMatchObject({ outcome: { kind: 'broken', detail: reason } });
  });

  it('reports the login a dry run skipped as broken', () => {
    expect(
      planGarminCheck({
        run: { result: 'no-tokens' },
        decision: { kind: 'attempt', reason: 'no cached tokens' },
        dryRun: true,
      }),
    ).toEqual({
      kind: 'report',
      outcome: {
        kind: 'broken',
        detail: 'no cached tokens (login skipped: --dry-run)',
        remedy: 'run bun scripts/garmin-fetch.ts to force a fresh login',
      },
    });
  });

  it('logs in fresh when the decision attempts', () => {
    expect(
      planGarminCheck({
        run: { result: 'failed', error: '401' },
        decision: { kind: 'attempt', reason: 'cached tokens were rejected by Garmin' },
        dryRun: false,
      }),
    ).toEqual({ kind: 'repair', reason: 'cached tokens were rejected by Garmin' });
  });
});

describe('lastRepairAttemptMs', () => {
  it("is this run's attempt when it made one, else the one before", () => {
    expect(lastRepairAttemptMs({ attempted: true, atMs: NOW }, NOW - MS_PER_DAY)).toBe(NOW);
    expect(lastRepairAttemptMs({ attempted: true, atMs: NOW }, null)).toBe(NOW);
    expect(lastRepairAttemptMs({ attempted: false }, NOW - MS_PER_DAY)).toBe(NOW - MS_PER_DAY);
    expect(lastRepairAttemptMs({ attempted: false }, null)).toBeNull();
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

// ─── resolvePiProviderAuth ────────────────────────────────────────────────────

describe('resolvePiProviderAuth', () => {
  it('classifies a well-formed key-authenticated provider entry as static-key', () => {
    const auth = resolvePiProviderAuth({
      baseUrl: 'http://192.168.0.80:8000/v1',
      apiKey: 'sk-local',
      models: [],
    });
    expect(auth).toEqual({
      kind: 'static-key',
      baseUrl: 'http://192.168.0.80:8000/v1',
      apiKey: 'sk-local',
    });
  });

  it.each([
    ['missing entry', null],
    ['non-object entry', 'nope'],
    ['empty apiKey', { baseUrl: 'http://x/v1', apiKey: '' }],
    ['non-string apiKey', { baseUrl: 'http://x/v1', apiKey: 42 }],
    ['missing baseUrl', { apiKey: 'sk-local' }],
    ['empty baseUrl', { baseUrl: '', apiKey: 'sk-local' }],
  ])('treats %s as oauth (conservative default)', (_label, entry) => {
    expect(resolvePiProviderAuth(entry)).toEqual({ kind: 'oauth' });
  });
});

// ─── classifyApiKeyProbe ──────────────────────────────────────────────────────

describe('classifyApiKeyProbe', () => {
  it('reports healthy on HTTP 200', () => {
    expect(classifyApiKeyProbe({ status: 200, error: null })).toEqual({
      kind: 'healthy',
      detail: 'api key accepted by the provider endpoint',
    });
  });

  it('reports broken with a remedy on 401 and 403, without echoing the key', () => {
    for (const status of [401, 403]) {
      const outcome = classifyApiKeyProbe({ status, error: null });
      expect(outcome.kind).toBe('broken');
      if (outcome.kind === 'broken') expect(outcome.detail).toContain(String(status));
    }
  });

  it('reports unknown for an understood-but-unexpected HTTP status', () => {
    expect(classifyApiKeyProbe({ status: 503, error: null }).kind).toBe('unknown');
  });

  it('reports broken with the endpoint remedy when the endpoint is unreachable', () => {
    const outcome = classifyApiKeyProbe({ status: null, error: 'Connection refused' });
    expect(outcome.kind).toBe('broken');
    if (outcome.kind === 'broken') expect(outcome.detail).toContain('Connection refused');
  });
});
