import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type GarminSessionClient,
  type SessionRetry,
  openGarminSession,
  requireGarminCredentials,
} from './garmin-session.js';

const credentials = { email: 'runner@example.com', password: 'hunter2' };

type FakeGarmin = GarminSessionClient & { readonly calls: string[] };

/** A Garmin client whose profile check fails `profileFailures` times; it writes token files 0644 like a fresh export. */
const fakeGarmin = (profileFailures = 0, loginFailures = 0): FakeGarmin => {
  const calls: string[] = [];
  let profileLeft = profileFailures;
  let loginLeft = loginFailures;
  return {
    calls,
    login: async (email, password) => {
      calls.push(`login ${email} ${password}`);
      if (loginLeft-- > 0) throw new Error('preauth 400');
    },
    loadTokenByFile: async (dir) => {
      calls.push(`load ${dir}`);
    },
    getUserProfile: async () => {
      calls.push('profile');
      if (profileLeft-- > 0) throw new Error('401 token expired');
    },
    exportTokenToFile: async (dir) => {
      calls.push(`export ${dir}`);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'oauth1_token.json'), '{}', { mode: 0o644 });
      await writeFile(join(dir, 'oauth2_token.json'), '{}', { mode: 0o644 });
    },
  };
};

const noRetry: SessionRetry = {
  login: { attempts: 1, delayMs: 0 },
  tokenCheck: { attempts: 1, delayMs: 0 },
};

describe('openGarminSession', () => {
  let home: string;
  let tokenDir: string;
  const originalHome = process.env.HOME;
  let stderr: string[];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'garmin-session-'));
    tokenDir = join(home, '.cache', 'garmin');
    process.env.HOME = home;
    stderr = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      stderr.push(String(line));
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.env.HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  const cacheTokens = async (): Promise<void> => {
    await mkdir(tokenDir, { recursive: true });
    await writeFile(join(tokenDir, 'oauth2_token.json'), '{}');
  };

  it('reuses cached tokens Garmin still accepts, without logging in', async () => {
    await cacheTokens();
    const client = fakeGarmin();
    const narration: string[] = [];

    await openGarminSession(client, credentials, { narrate: (l) => narration.push(l) });

    expect(client.calls).toEqual([`load ${tokenDir}`, 'profile']);
    expect(narration).toEqual(['[INFO] Loading cached tokens...', '[INFO] Cached tokens valid']);
  });

  it('logs in fresh when the profile check rejects the cached tokens, and keeps the export owner-only', async () => {
    await cacheTokens();
    const client = fakeGarmin(1);
    const narration: string[] = [];

    await openGarminSession(client, credentials, { narrate: (l) => narration.push(l) });

    expect(client.calls).toEqual([
      `load ${tokenDir}`,
      'profile',
      'login runner@example.com hunter2',
      `export ${tokenDir}`,
    ]);
    expect(narration).toEqual([
      '[INFO] Loading cached tokens...',
      '[INFO] Cached tokens expired, logging in fresh...',
      '[INFO] Login successful, tokens cached',
    ]);
    for (const file of ['oauth1_token.json', 'oauth2_token.json']) {
      expect((await stat(join(tokenDir, file))).mode & 0o777).toBe(0o600);
    }
  });

  it('names why it gave up on the cached tokens on stderr, even when narration is silent', async () => {
    await cacheTokens();

    await openGarminSession(fakeGarmin(1), credentials, { narrate: () => {} });

    expect(stderr).toEqual([
      '[WARN] Cached Garmin tokens rejected, logging in fresh: 401 token expired',
    ]);
  });

  it('logs in when no tokens are cached', async () => {
    const client = fakeGarmin();
    const narration: string[] = [];

    await openGarminSession(client, credentials, { narrate: (l) => narration.push(l) });

    expect(client.calls).toEqual(['login runner@example.com hunter2', `export ${tokenDir}`]);
    expect(narration).toEqual([
      '[INFO] No cached tokens, logging in...',
      '[INFO] Login successful, tokens cached',
    ]);
  });

  it('retries a failed token check under a retry policy before logging in fresh', async () => {
    await cacheTokens();
    const client = fakeGarmin(1);
    const retry: SessionRetry = { ...noRetry, tokenCheck: { attempts: 3, delayMs: 0 } };

    await openGarminSession(client, credentials, { narrate: () => {}, retry });

    expect(client.calls).toEqual([`load ${tokenDir}`, 'profile', 'profile']);
    expect(stderr).toEqual([
      '[WARN] getUserProfile attempt 1/3 failed: 401 token expired, retrying in 0ms...',
    ]);
  });

  const twoLogins: SessionRetry = { ...noRetry, login: { attempts: 2, delayMs: 0 } };

  it('retries a failed login under a retry policy', async () => {
    const client = fakeGarmin(0, 1);

    await openGarminSession(client, credentials, { narrate: () => {}, retry: twoLogins });

    expect(client.calls.filter((c) => c.startsWith('login'))).toHaveLength(2);
    expect(client.calls.at(-1)).toBe(`export ${tokenDir}`);
  });

  it('gives up with the last login error once the retry policy is spent', async () => {
    await expect(
      openGarminSession(fakeGarmin(0, 2), credentials, { narrate: () => {}, retry: twoLogins }),
    ).rejects.toThrow('preauth 400');
  });

  it('tries each call once without a retry policy', async () => {
    await cacheTokens();
    const client = fakeGarmin(1);

    await openGarminSession(client, credentials, { narrate: () => {} });

    expect(client.calls.filter((c) => c === 'profile')).toHaveLength(1);
  });
});

describe('requireGarminCredentials', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the email and password from the environment', () => {
    expect(requireGarminCredentials({ GARMIN_EMAIL: 'a@b.c', GARMIN_PASSWORD: 'pw' })).toEqual({
      email: 'a@b.c',
      password: 'pw',
    });
  });

  it.each([{}, { GARMIN_EMAIL: 'a@b.c' }, { GARMIN_EMAIL: 'a@b.c', GARMIN_PASSWORD: '' }])(
    'exits 1 with a fatal line when a credential is missing (%j)',
    (env) => {
      const fatal = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`exit ${code}`);
      });

      expect(() => requireGarminCredentials(env)).toThrow('exit 1');
      expect(exit).toHaveBeenCalledWith(1);
      expect(fatal).toHaveBeenCalledWith(
        '[FATAL] GARMIN_EMAIL and GARMIN_PASSWORD env vars required',
      );
    },
  );
});
