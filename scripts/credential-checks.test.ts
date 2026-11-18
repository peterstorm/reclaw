import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MS_PER_HOUR,
  type NotebookLMSource,
  type ProbeOutcome,
} from '../src/core/credential-health.js';
import {
  type CallResult,
  type GarminPorts,
  type NotebookLMPorts,
  checkGarmin,
  checkNotebookLM,
} from './credential-checks.js';

const NOW = Date.UTC(2026, 10, 18, 9, 0, 0);

const fileSource = (authToken: string): NotebookLMSource => ({
  kind: 'token',
  origin: 'file',
  authToken,
  cookies: 'SID=abc',
  ageDays: 3,
});

const fails = (error: string): CallResult => ({ ok: false, error });
const OK: CallResult = { ok: true };

type FakeNotebookLM = NotebookLMPorts & { readonly calls: string[] };

/**
 * NotebookLM ports that serve `sources` to successive reads (the last one again once
 * they run out) and `probes` to successive auth checks, recording every call.
 */
const fakeNotebookLM = (script: {
  readonly sources: readonly [NotebookLMSource, ...NotebookLMSource[]];
  readonly probes: readonly CallResult[];
  readonly reauth?: CallResult;
}): FakeNotebookLM => {
  const calls: string[] = [];
  let reads = 0;
  let probes = 0;
  return {
    calls,
    readSource: () => {
      calls.push('readSource');
      return script.sources[Math.min(reads++, script.sources.length - 1)] ?? script.sources[0];
    },
    authWorks: async (authToken) => {
      calls.push(`authWorks ${authToken}`);
      return script.probes[probes++] ?? OK;
    },
    reauth: async () => {
      calls.push('reauth');
      return script.reauth ?? OK;
    },
  };
};

type FakeGarmin = GarminPorts & { readonly calls: string[] };

const fakeGarmin = (probe: CallResult | 'no-tokens', relogin: ProbeOutcome): FakeGarmin => {
  const calls: string[] = [];
  return {
    calls,
    probe: async () => {
      calls.push('probe');
      if (probe === 'no-tokens') return { result: 'no-tokens' };
      return probe.ok ? { result: 'ok' } : { result: 'failed', error: probe.error };
    },
    relogin: async (reason) => {
      calls.push(`relogin ${reason}`);
      return relogin;
    },
  };
};

const fresh = { nowMs: NOW, lastAttemptMs: null, dryRun: false } as const;

beforeEach(() => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('checkNotebookLM', () => {
  it('leaves the attempt unset when the decision skips the repair', async () => {
    const ports = fakeNotebookLM({ sources: [fileSource('t1')], probes: [OK] });
    const check = await checkNotebookLM(ports, fresh);

    expect(check).toEqual({
      probe: {
        id: 'notebooklm',
        outcome: { kind: 'healthy', detail: 'credentials.json is 3 days old' },
      },
      attempt: { attempted: false },
    });
    expect(ports.calls).toEqual(['readSource', 'authWorks t1']);
  });

  it('leaves the attempt unset on a dry run, without re-authenticating', async () => {
    const ports = fakeNotebookLM({ sources: [fileSource('t1')], probes: [fails('401')] });
    const check = await checkNotebookLM(ports, { ...fresh, dryRun: true });

    expect(check.attempt).toEqual({ attempted: false });
    expect(check.probe.outcome).toMatchObject({
      kind: 'broken',
      detail: 'the auth probe failed (repair skipped: --dry-run)',
    });
    expect(ports.calls).not.toContain('reauth');
  });

  it('leaves the attempt unset while the cooldown holds', async () => {
    const ports = fakeNotebookLM({ sources: [fileSource('t1')], probes: [fails('401')] });
    const check = await checkNotebookLM(ports, { ...fresh, lastAttemptMs: NOW - MS_PER_HOUR });

    expect(check.attempt).toEqual({ attempted: false });
    expect(check.probe.outcome).toMatchObject({ kind: 'broken', detail: '401' });
    expect(ports.calls).not.toContain('reauth');
  });

  it('records the repair at nowMs, and reports it repaired once the new credential passes', async () => {
    const ports = fakeNotebookLM({
      sources: [fileSource('t1'), fileSource('t2')],
      probes: [fails('401'), OK],
    });
    const check = await checkNotebookLM(ports, fresh);

    expect(check).toEqual({
      probe: {
        id: 'notebooklm',
        outcome: { kind: 'repaired', detail: 're-authenticated (the auth probe failed)' },
      },
      attempt: { attempted: true, atMs: NOW },
    });
    expect(ports.calls).toEqual([
      'readSource',
      'authWorks t1',
      'reauth',
      'readSource',
      'authWorks t2',
    ]);
  });

  it('reports broken when the re-auth succeeds but the re-probe still fails', async () => {
    const ports = fakeNotebookLM({
      sources: [fileSource('t1'), fileSource('t2')],
      probes: [fails('401'), fails('still 401')],
    });
    const check = await checkNotebookLM(ports, fresh);

    expect(check.attempt).toEqual({ attempted: true, atMs: NOW });
    expect(check.probe.outcome).toMatchObject({
      kind: 'broken',
      detail: 're-auth ran but the credential still fails: still 401',
    });
  });

  it('reports broken when the re-auth leaves no usable credential, or fails outright', async () => {
    const absent: NotebookLMSource = { kind: 'absent', reason: 'credentials.json has no cookies' };
    const leftNothing = await checkNotebookLM(
      fakeNotebookLM({ sources: [fileSource('t1'), absent], probes: [fails('401')] }),
      fresh,
    );
    expect(leftNothing.probe.outcome).toMatchObject({
      kind: 'broken',
      detail:
        're-auth reported success but left no usable credential (credentials.json has no cookies)',
    });

    const reauthFailed = await checkNotebookLM(
      fakeNotebookLM({
        sources: [fileSource('t1')],
        probes: [fails('401')],
        reauth: fails('Google challenged the login'),
      }),
      fresh,
    );
    expect(reauthFailed.attempt).toEqual({ attempted: true, atMs: NOW });
    expect(reauthFailed.probe.outcome).toMatchObject({
      kind: 'broken',
      detail: 're-auth failed after the auth probe failed: Google challenged the login',
    });
  });
});

describe('checkGarmin', () => {
  const repaired: ProbeOutcome = { kind: 'repaired', detail: 'logged in fresh' };

  it('leaves the attempt unset while the cached tokens work', async () => {
    const ports = fakeGarmin(OK, repaired);
    const check = await checkGarmin(ports, fresh);

    expect(check).toEqual({
      probe: {
        id: 'garmin',
        outcome: { kind: 'healthy', detail: 'cached tokens accepted by Garmin' },
      },
      attempt: { attempted: false },
    });
    expect(ports.calls).toEqual(['probe']);
  });

  it('leaves the attempt unset on a dry run, without logging in', async () => {
    const ports = fakeGarmin('no-tokens', repaired);
    const check = await checkGarmin(ports, { ...fresh, dryRun: true });

    expect(check.attempt).toEqual({ attempted: false });
    expect(check.probe.outcome).toMatchObject({
      kind: 'broken',
      detail: 'no cached tokens (login skipped: --dry-run)',
    });
    expect(ports.calls).toEqual(['probe']);
  });

  it('leaves the attempt unset while the cooldown holds', async () => {
    const ports = fakeGarmin(fails('401'), repaired);
    const check = await checkGarmin(ports, { ...fresh, lastAttemptMs: NOW - MS_PER_HOUR });

    expect(check.attempt).toEqual({ attempted: false });
    expect(ports.calls).toEqual(['probe']);
  });

  it('records the login at nowMs and reports what it returned', async () => {
    const ports = fakeGarmin(fails('401'), repaired);
    const check = await checkGarmin(ports, fresh);

    expect(check).toEqual({
      probe: { id: 'garmin', outcome: repaired },
      attempt: { attempted: true, atMs: NOW },
    });
    expect(ports.calls).toEqual(['probe', 'relogin cached tokens were rejected by Garmin']);
  });
});
