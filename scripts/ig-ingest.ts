#!/usr/bin/env bun

/**
 * ig-ingest (I/O shell) — turn Instagram posts/reels into vault notes (caption + Whisper
 * transcript). All decisions live in the pure core (`src/core/instagram-*.ts`) behind
 * `src/orchestration/instagram-ingest.ts`; this file only wires adapters from the environment.
 *
 * Usage: bun scripts/ig-ingest.ts <instagram-url|@handle> [--limit N] [--video] [--force]
 *                                  [--model tiny|base|small|medium|large-v3]
 *
 * Prints one JSON report on stdout and progress on stderr. Exit 1 if nothing could be saved
 * or any post failed; re-running is safe (existing notes are skipped).
 *
 * Env:
 *   APIFY_TOKEN           required — Apify API token (https://console.apify.com/settings/integrations)
 *   RECLAW_VAULT_ROOT     vault location (default ~/dev/notes/remotevault)
 *   RECLAW_IG_VIDEO_DIR   where --video files go (default ~/downloads/instagram)
 *   IG_WHISPER_MODEL      default model (default small; use medium for Danish)
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_WHISPER_MODEL,
  INGEST_USAGE,
  parseIngestArgs,
  parseWhisperModel,
  summarizeReport,
} from '../src/core/instagram-ingest.js';
import { createApifyInstagramScraper } from '../src/infra/apify-instagram.js';
import { createMediaFetcher } from '../src/infra/instagram-media.js';
import { fsInstagramVault } from '../src/infra/instagram-vault.js';
import { createWhisperTranscriber } from '../src/infra/whisper-transcriber.js';
import { ingestInstagram } from '../src/orchestration/instagram-ingest.js';

function fail(message: string): never {
  process.stderr.write(`ig-ingest: ${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(`${INGEST_USAGE}\n`);
  process.exit(0);
}

const envModel = process.env.IG_WHISPER_MODEL;
const defaultModel =
  envModel === undefined
    ? { ok: true as const, value: DEFAULT_WHISPER_MODEL }
    : parseWhisperModel(envModel);
if (!defaultModel.ok) fail(`IG_WHISPER_MODEL: ${defaultModel.error}`);

const request = parseIngestArgs(args, defaultModel.value);
if (!request.ok) fail(request.error);

const token = process.env.APIFY_TOKEN;
if (token === undefined || token.length === 0) {
  fail('APIFY_TOKEN is not set (create one at https://console.apify.com/settings/integrations).');
}

const media = createMediaFetcher({
  libraryDir: process.env.RECLAW_IG_VIDEO_DIR ?? join(homedir(), 'downloads/instagram'),
});
const vault = await fsInstagramVault(
  process.env.RECLAW_VAULT_ROOT ?? join(homedir(), 'dev/notes/remotevault'),
);
const transcribe = createWhisperTranscriber();

const result = await ingestInstagram(request.value, {
  scrape: createApifyInstagramScraper({ token }),
  fetchMedia: media.fetchMedia,
  discardScratch: media.discardScratch,
  transcribe: async (path, model) => {
    process.stderr.write(`ig-ingest: transcribing with ${model} …\n`);
    return transcribe(path, model);
  },
  vault,
  today: () => new Date().toISOString().slice(0, 10),
});
if (!result.ok) fail(result.error);

const report = result.value;
const summary = summarizeReport(report);
process.stdout.write(
  `${JSON.stringify(
    {
      target: report.request.target.url,
      summary,
      outcomes: report.outcomes,
      rejected: report.rejected,
      warnings: report.warnings,
    },
    null,
    2,
  )}\n`,
);
process.exit(summary.failed > 0 || summary.saved + summary.skippedExisting === 0 ? 1 : 0);
