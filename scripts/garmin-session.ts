/**
 * Garmin Connect session for every Garmin CLI (garmin-fetch,
 * garmin-schedule-workout, garmin-reschedule-workout, credential-health's
 * repair): reuse the cached OAuth tokens when Garmin still accepts them, log in
 * fresh otherwise, and keep the token files owner-only. The token directory and
 * the 0600 export live here and nowhere else.
 */

import { existsSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { GarminConnect } from '@gooin/garmin-connect';

export type GarminCredentials = { readonly email: string; readonly password: string };

/** How many times to try a flaky Garmin call, and how long to wait between tries. */
type RetryPolicy = { readonly attempts: number; readonly delayMs: number };

/** The retry policy for the session's two remote calls. */
export type SessionRetry = { readonly login: RetryPolicy; readonly tokenCheck: RetryPolicy };

/**
 * garmin-fetch's policy: Garmin's preauth and profile endpoints intermittently
 * 400/5xx on transient blips, and a blip on the token check must not fall
 * through to a full re-login (the flakier path).
 */
export const PERSISTENT_RETRY: SessionRetry = {
  login: { attempts: 3, delayMs: 5000 },
  tokenCheck: { attempts: 3, delayMs: 2000 },
};

const SINGLE_TRY: SessionRetry = {
  login: { attempts: 1, delayMs: 0 },
  tokenCheck: { attempts: 1, delayMs: 0 },
};

export type SessionOptions = {
  /** Receives the progress lines; a caller that wants a quiet login passes a no-op. */
  readonly narrate: (line: string) => void;
  /** Absent: one try per call. */
  readonly retry?: SessionRetry;
};

/** The calls a session makes: GarminConnect in production, a fake in the tests. */
export type GarminSessionClient = {
  readonly login: (email: string, password: string) => Promise<unknown>;
  readonly loadTokenByFile: (dir: string) => Promise<void>;
  readonly getUserProfile: () => Promise<unknown>;
  readonly exportTokenToFile: (dir: string) => Promise<void>;
};

/** Where the OAuth tokens are cached; garmin-fetch's daily JSON lives beneath it. */
export const garminTokenDir = (): string =>
  join(process.env.HOME ?? '/home/peterstorm', '.cache', 'garmin');

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** GARMIN_EMAIL and GARMIN_PASSWORD; exits 1 when either is missing. */
export function requireGarminCredentials(
  env: Readonly<Record<string, string | undefined>> = process.env,
): GarminCredentials {
  const email = env.GARMIN_EMAIL;
  const password = env.GARMIN_PASSWORD;
  if (!email || !password) {
    console.error('[FATAL] GARMIN_EMAIL and GARMIN_PASSWORD env vars required');
    process.exit(1);
  }
  return { email, password };
}

/** Each failed try but the last is a stderr warning; the last one's error is thrown. */
async function withRetry<T>(label: string, fn: () => Promise<T>, policy: RetryPolicy): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < policy.attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < policy.attempts - 1) {
        console.error(
          `[WARN] ${label} attempt ${i + 1}/${policy.attempts} failed: ${errorText(e)}, retrying in ${policy.delayMs}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, policy.delayMs));
      }
    }
  }
  throw lastErr;
}

/** Persist the client's tokens (they may have refreshed) and keep them owner-only. */
export async function exportGarminTokens(
  client: Pick<GarminSessionClient, 'exportTokenToFile'>,
): Promise<void> {
  const tokenDir = garminTokenDir();
  await client.exportTokenToFile(tokenDir);
  await chmod(join(tokenDir, 'oauth1_token.json'), 0o600);
  await chmod(join(tokenDir, 'oauth2_token.json'), 0o600);
}

/** Authenticate `client`: the cached tokens when Garmin accepts them, else a fresh login. */
export async function openGarminSession(
  client: GarminSessionClient,
  { email, password }: GarminCredentials,
  { narrate, retry = SINGLE_TRY }: SessionOptions,
): Promise<void> {
  const tokenDir = garminTokenDir();
  const freshLogin = async (): Promise<void> => {
    await withRetry('login', () => client.login(email, password), retry.login);
    await exportGarminTokens(client);
    narrate('[INFO] Login successful, tokens cached');
  };

  if (!existsSync(join(tokenDir, 'oauth2_token.json'))) {
    narrate('[INFO] No cached tokens, logging in...');
    await freshLogin();
    return;
  }
  narrate('[INFO] Loading cached tokens...');
  try {
    await client.loadTokenByFile(tokenDir);
    await withRetry('getUserProfile', () => client.getUserProfile(), retry.tokenCheck);
    narrate('[INFO] Cached tokens valid');
  } catch (e) {
    console.error(`[WARN] Cached Garmin tokens rejected, logging in fresh: ${errorText(e)}`);
    narrate('[INFO] Cached tokens expired, logging in fresh...');
    await freshLogin();
  }
}

/** A GarminConnect client with an open session. */
export async function connectGarmin(
  credentials: GarminCredentials,
  options: SessionOptions,
): Promise<GarminConnect> {
  const client = new GarminConnect({ username: credentials.email, password: credentials.password });
  await openGarminSession(client, credentials, options);
  return client;
}
