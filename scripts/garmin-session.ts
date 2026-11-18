/**
 * Garmin Connect session for the workout CLIs (garmin-schedule-workout,
 * garmin-reschedule-workout): reuse the cached OAuth tokens when Garmin still
 * accepts them, log in fresh otherwise, and keep the token files owner-only.
 * Exits 1 when GARMIN_EMAIL / GARMIN_PASSWORD are missing.
 */

import { existsSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { GarminConnect } from '@gooin/garmin-connect';

const TOKEN_DIR = join(process.env.HOME ?? '/home/peterstorm', '.cache', 'garmin');

/** Persist the client's tokens (they may have refreshed) and keep them owner-only. */
export async function exportGarminTokens(client: GarminConnect): Promise<void> {
  await client.exportTokenToFile(TOKEN_DIR);
  await chmod(join(TOKEN_DIR, 'oauth1_token.json'), 0o600);
  await chmod(join(TOKEN_DIR, 'oauth2_token.json'), 0o600);
}

/** `narrate` receives the progress lines; a caller that wants a quiet login passes a no-op. */
export async function connectGarmin(narrate: (line: string) => void): Promise<GarminConnect> {
  const email = process.env.GARMIN_EMAIL;
  const password = process.env.GARMIN_PASSWORD;
  if (!email || !password) {
    console.error('[FATAL] GARMIN_EMAIL and GARMIN_PASSWORD env vars required');
    process.exit(1);
  }

  const client = new GarminConnect({ username: email, password: password });
  const freshLogin = async (): Promise<void> => {
    await client.login(email, password);
    await exportGarminTokens(client);
    narrate('[INFO] Login successful, tokens cached');
  };

  if (existsSync(join(TOKEN_DIR, 'oauth2_token.json'))) {
    narrate('[INFO] Loading cached tokens...');
    try {
      await client.loadTokenByFile(TOKEN_DIR);
      await client.getUserProfile();
      narrate('[INFO] Cached tokens valid');
    } catch {
      narrate('[INFO] Cached tokens expired, logging in fresh...');
      await freshLogin();
    }
  } else {
    narrate('[INFO] No cached tokens, logging in...');
    await freshLogin();
  }
  return client;
}
