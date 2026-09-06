#!/usr/bin/env bun
/**
 * NotebookLM re-authentication.
 *
 * Regenerates the cached `credentials.json` (auth token + cookies) that the
 * NotebookLM SDK reuses. Those cookies expire after ~24 days; once stale,
 * `notebooks.list()` returns 400 Bad Request and every research/podcast job
 * fails the health check (src/infra/notebooklm-client.ts:350, runbook.md).
 *
 * Why this script exists instead of the SDK's built-in auto-login:
 *   1. Google serves the `WebLiteSignIn` flow on this host, where the email
 *      field is `input[name="identifier"]` (type=text). The SDK's login waits
 *      for `input[type="email"]:visible`, which never appears → timeout.
 *   2. nixpkgs `playwright-driver.browsers` ships a chromium revision that
 *      differs from the one `playwright-core` pins in browsers.json. Playwright
 *      looks for `chromium_headless_shell-<wanted>` and won't find it.
 *
 * This script fixes both: it shims the wanted revision onto whatever chromium
 * the nix store provides, drives the login with the correct selectors, extracts
 * the SNlM0e token + cookie header, verifies them against the real health check,
 * then writes `credentials.json`.
 *
 * Usage (GOOGLE_EMAIL / GOOGLE_PASSWORD come from the reclaw systemd env via SOPS):
 *   GOOGLE_EMAIL=... GOOGLE_PASSWORD=... \
 *   PLAYWRIGHT_BROWSERS_PATH=<nix playwright-driver.browsers> \
 *   bun scripts/notebooklm-reauth.ts
 *
 * No service restart is needed: the adapter is lazy-initialized and only cached
 * on success, so the next job reads the fresh credentials.json automatically.
 */

import { readFileSync, writeFileSync, mkdirSync, symlinkSync, existsSync, readdirSync, rmSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import {
  NOTEBOOKLM_WEB_ORIGIN,
  NOTEBOOKLM_WEB_ORIGINS,
  isNotebookLMWebUrl,
} from '../src/infra/notebooklm-web.js';

// NOTE: playwright-core and notebooklm-kit snapshot PLAYWRIGHT_BROWSERS_PATH at
// import time, so they are dynamically imported in main() *after* the shim sets it.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CREDENTIALS_PATH = join(REPO_ROOT, 'credentials.json');

/** Chromium revision that the installed playwright-core expects. */
function wantedChromiumRevision(): string {
  const browsersJson = JSON.parse(
    readFileSync(join(REPO_ROOT, 'node_modules/playwright-core/browsers.json'), 'utf8'),
  ) as { browsers: ReadonlyArray<{ name: string; revision: string }> };
  const chromium = browsersJson.browsers.find((b) => b.name === 'chromium');
  if (!chromium) throw new Error('chromium not found in playwright-core browsers.json');
  return chromium.revision;
}

/**
 * Build a writable browsers dir that maps the playwright-wanted chromium
 * revision onto whatever revision the nix store actually ships, and return
 * its path. The nix store is read-only, so the shim lives under ~/.cache.
 */
function shimBrowsersPath(): string {
  const nixPath = process.env['PLAYWRIGHT_BROWSERS_PATH'];
  if (!nixPath || !existsSync(nixPath)) {
    throw new Error('PLAYWRIGHT_BROWSERS_PATH must point at the nix playwright-driver.browsers store path');
  }
  const wanted = wantedChromiumRevision();
  const entries = readdirSync(nixPath);
  const haveShell = entries.find((e) => e.startsWith('chromium_headless_shell-'));
  const haveFull = entries.find((e) => e.startsWith('chromium-') && !e.startsWith('chromium_'));
  if (!haveShell) throw new Error(`no chromium_headless_shell-* in ${nixPath}`);

  const shim = join(homedir(), '.cache', 'reclaw-playwright-shim');
  rmSync(shim, { recursive: true, force: true });
  mkdirSync(shim, { recursive: true });
  for (const e of entries) symlinkSync(join(nixPath, e), join(shim, e));
  // Alias the wanted revision onto the available one — skip if they already match
  // (the per-entry loop above already created the identically-named link).
  const wantedShell = join(shim, `chromium_headless_shell-${wanted}`);
  if (!existsSync(wantedShell)) {
    symlinkSync(join(nixPath, haveShell), wantedShell);
    if (haveFull) symlinkSync(join(nixPath, haveFull), join(shim, `chromium-${wanted}`));
    console.error(`[reauth] shimmed chromium revision ${wanted} -> ${haveShell}`);
  } else {
    console.error(`[reauth] chromium revision ${wanted} already present — no shim needed`);
  }
  return shim;
}

async function main(): Promise<void> {
  const email = process.env['GOOGLE_EMAIL'];
  const password = process.env['GOOGLE_PASSWORD'];
  if (!email || !password) {
    console.error('[reauth] missing GOOGLE_EMAIL / GOOGLE_PASSWORD');
    process.exit(1);
  }

  process.env['PLAYWRIGHT_BROWSERS_PATH'] = shimBrowsersPath();
  process.env['PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD'] = '1';

  // Imported here, after the env is set, so the browser registry resolves to the shim.
  const { chromium } = await import('playwright-core');
  const { createNotebookLMAdapter } = await import('../src/infra/notebooklm-client.js');

  const browser = await chromium.launch({ headless: true });
  let credentials: { authToken: string; cookies: string };
  try {
    const ctx = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await ctx.newPage();

    await page.goto(
      `https://accounts.google.com/ServiceLogin?continue=${NOTEBOOKLM_WEB_ORIGIN}/`,
      { waitUntil: 'networkidle', timeout: 60_000 },
    );

    // Email — WebLiteSignIn uses input[name="identifier"], not input[type=email].
    await page.fill('#identifierId, input[name="identifier"]', email, { timeout: 20_000 });
    await page.click('#identifierNext button, #identifierNext', { timeout: 10_000 })
      .catch(() => page.keyboard.press('Enter'));
    console.error('[reauth] email submitted');

    // Password
    await page.waitForSelector('input[type="password"]:visible, input[name="Passwd"]', { timeout: 25_000 });
    await page.waitForTimeout(1_000);
    await page.fill('input[type="password"], input[name="Passwd"]', password, { timeout: 20_000 });
    await page.click('#passwordNext button, #passwordNext', { timeout: 10_000 })
      .catch(() => page.keyboard.press('Enter'));
    console.error('[reauth] password submitted');

    await page
      .waitForURL((url) => isNotebookLMWebUrl(url.href), { timeout: 45_000 })
      .catch(() => undefined);
    await page.waitForTimeout(3_000);
    if (!isNotebookLMWebUrl(page.url())) {
      const heading = await page.locator('h1, [role=heading]').first().innerText().catch(() => '?');
      throw new Error(`login did not reach NotebookLM (stuck at "${heading}", url=${page.url()})`);
    }

    await page.goto(`${NOTEBOOKLM_WEB_ORIGIN}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
    await page.waitForTimeout(3_000);

    const authToken = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => ((window as any).WIZ_global_data && (window as any).WIZ_global_data.SNlM0e) || null,
    );
    if (!authToken) throw new Error('SNlM0e auth token not found on NotebookLM page');

    const cookies = await ctx.cookies([
      ...NOTEBOOKLM_WEB_ORIGINS,
      'https://accounts.google.com',
      'https://google.com',
    ]);
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    credentials = { authToken, cookies: cookieHeader };
    console.error(`[reauth] extracted token(${authToken.length}ch) cookies(${cookieHeader.length}ch)`);
  } finally {
    await browser.close();
  }

  // Verify against the real health check before persisting.
  console.error('[reauth] verifying credentials with notebooks.list()...');
  const adapter = await createNotebookLMAdapter({
    kind: 'token',
    authToken: credentials.authToken,
    cookies: credentials.cookies,
  });
  await adapter.dispose?.();

  writeFileSync(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2));
  chmodSync(CREDENTIALS_PATH, 0o600);
  console.error(`[reauth] OK — wrote ${CREDENTIALS_PATH}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[reauth] FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
