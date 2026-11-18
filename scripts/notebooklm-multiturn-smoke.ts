#!/usr/bin/env bun
/**
 * NotebookLM multi-turn smoke test.
 *
 * Asks two questions back-to-back against an existing notebook, threading
 * conversationId from the first response into the second. Eyeball whether
 * the second answer actually references the first turn's content.
 *
 * Usage:
 *   bun scripts/notebooklm-multiturn-smoke.ts <notebookId> ["q1"] ["q2"]
 *
 * Auth: prefers NOTEBOOKLM_AUTH_TOKEN + NOTEBOOKLM_COOKIES; falls back to
 * GOOGLE_EMAIL + GOOGLE_PASSWORD (Playwright). The SDK reuses any cached
 * credentials.json at the cwd.
 *
 * Defaults (if q1/q2 are omitted) probe whether turn 2 understands "the
 * second point" — i.e. requires turn 1 context to answer coherently.
 */

import { NotebookLMClient } from 'notebooklm-kit';
import { FALLBACK_BL, fetchCurrentBuildLabel } from '../src/infra/notebooklm-client.js';

const DEFAULT_Q1 = 'List the three most important claims this notebook makes, numbered 1, 2, 3.';
const DEFAULT_Q2 = 'Expand on the second point. What evidence in the sources supports it?';

/** The SDK leaves `text` unset when it could not decode an answer. */
function preview(text: string | undefined, n = 600): string {
  if (text === undefined) return '(no text)';
  const trimmed = text.trim();
  return trimmed.length <= n ? trimmed : `${trimmed.slice(0, n)}…`;
}

/** Token + cookies win; Google login is the fallback; neither means no auth. */
function pickAuth(
  authToken: string | undefined,
  cookies: string | undefined,
  email: string | undefined,
  password: string | undefined,
) {
  if (authToken && cookies) return { authToken, cookies };
  if (email && password) return { auth: { email, password, headless: true } };
  return null;
}

/** Connect with whichever auth the env offers and pass the notebooks.list() health check. */
async function connectFromEnv(): Promise<NotebookLMClient> {
  const authToken = process.env.NOTEBOOKLM_AUTH_TOKEN;
  const cookies = process.env.NOTEBOOKLM_COOKIES;
  const email = process.env.GOOGLE_EMAIL;
  const password = process.env.GOOGLE_PASSWORD;

  let bl: string;
  try {
    bl = await fetchCurrentBuildLabel();
  } catch {
    bl = FALLBACK_BL;
  }

  const authOpts = pickAuth(authToken, cookies, email, password);
  if (authOpts === null) {
    console.error('Need NOTEBOOKLM_AUTH_TOKEN+NOTEBOOKLM_COOKIES or GOOGLE_EMAIL+GOOGLE_PASSWORD');
    process.exit(1);
  }
  console.log(`auth: ${'authToken' in authOpts ? 'token' : 'google'}`);

  const sdk = new NotebookLMClient({
    ...authOpts,
    autoRefresh: { enabled: true, interval: 10 * 60 * 1000 },
    urlParams: { bl },
  });

  await sdk.connect();
  await sdk.notebooks.list(); // health check
  return sdk;
}

async function main(): Promise<void> {
  const [, , notebookIdArg, q1Arg, q2Arg] = process.argv;
  if (!notebookIdArg) {
    console.error('Usage: bun scripts/notebooklm-multiturn-smoke.ts <notebookId> ["q1"] ["q2"]');
    process.exit(1);
  }
  const notebookId = notebookIdArg;
  const q1 = q1Arg ?? DEFAULT_Q1;
  const q2 = q2Arg ?? DEFAULT_Q2;

  const sdk = await connectFromEnv();

  console.log('\n── Turn 1 ──────────────────────────────────────────────');
  console.log(`Q: ${q1}\n`);
  const r1 = await sdk.generation.chat(notebookId, q1);
  console.log(`A: ${preview(r1.text)}\n`);
  console.log(`conversationId: ${r1.conversationId ?? '(none)'}`);
  console.log(`messageIds:     ${r1.messageIds?.join(', ') ?? '(none)'}`);
  console.log(`citations:      ${r1.citations?.join(', ') ?? '(none)'}`);

  console.log('\n── Turn 2 (with conversationId) ────────────────────────');
  console.log(`Q: ${q2}\n`);
  const r2 = await sdk.generation.chat(
    notebookId,
    q2,
    r1.conversationId === undefined ? {} : { conversationId: r1.conversationId },
  );
  console.log(`A: ${preview(r2.text)}\n`);
  console.log(`conversationId: ${r2.conversationId ?? '(none)'}`);
  console.log(`messageIds:     ${r2.messageIds?.join(', ') ?? '(none)'}`);

  console.log('\n── Verdict ─────────────────────────────────────────────');
  console.log(`Same conversationId echoed back? ${r2.conversationId === r1.conversationId}`);
  console.log(`Eyeball turn 2: did it reference "the second point" from turn 1?`);
  console.log('  - YES → multi-turn works on conversationId alone, ship it.');
  console.log(`  - NO  → SDK doesn't thread context; fall back to /ask one-shot or fork SDK.`);

  sdk.dispose();
}

main().catch((err) => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});
