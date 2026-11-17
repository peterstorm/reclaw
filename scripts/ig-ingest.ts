#!/usr/bin/env bun

/**
 * ig-ingest (I/O shell) — turn Instagram posts/reels into vault notes: caption, alt text,
 * Whisper transcript, and the text shown in the video or images (OCR). All decisions live in
 * the pure core (`src/core/instagram-*.ts`) behind `src/orchestration/instagram-ingest.ts`;
 * this file only wires adapters from the environment.
 *
 * Usage: bun scripts/ig-ingest.ts <instagram-url|@handle> [--limit N] [--video] [--force]
 *                                  [--no-screen-text] [--model tiny|base|small|medium|large-v3]
 *
 * Prints one JSON report on stdout and progress on stderr. Exit 1 if nothing could be saved
 * or any post failed; re-running is safe (existing notes are skipped).
 *
 * Env:
 *   APIFY_TOKEN           Apify API token. When unset, read from APIFY_TOKEN_FILE.
 *   APIFY_TOKEN_FILE      default /run/secrets/reclaw-apify-token (sops-nix). Reclaw's agent
 *                         sessions do not inherit service secrets, so chat runs use this file.
 *   RECLAW_VAULT_ROOT     vault location (default ~/dev/notes/remotevault)
 *   RECLAW_IG_VIDEO_DIR   where --video files go (default ~/downloads/instagram)
 *   IG_WHISPER_MODEL      default model (default small; use medium for Danish)
 */

import { readFile } from 'node:fs/promises';
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
import { createTesseractTextReader } from '../src/infra/tesseract-text-reader.js';
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

const DEFAULT_TOKEN_FILE = '/run/secrets/reclaw-apify-token';
const tokenFile = process.env.APIFY_TOKEN_FILE ?? DEFAULT_TOKEN_FILE;
const token =
  process.env.APIFY_TOKEN?.trim() ||
  (await readFile(tokenFile, 'utf8').then(
    (t) => t.trim(),
    () => '',
  ));
if (token.length === 0) {
  fail(
    `No Apify token: APIFY_TOKEN is unset and ${tokenFile} is unreadable (create one at https://console.apify.com/settings/integrations).`,
  );
}

const media = createMediaFetcher({
  libraryDir: process.env.RECLAW_IG_VIDEO_DIR ?? join(homedir(), 'downloads/instagram'),
});
const vault = await fsInstagramVault(
  process.env.RECLAW_VAULT_ROOT ?? join(homedir(), 'dev/notes/remotevault'),
);
const transcribe = createWhisperTranscriber();
const reader = createTesseractTextReader();
const progress = (message: string) => process.stderr.write(`ig-ingest: ${message}\n`);

const result = await ingestInstagram(request.value, {
  scrape: createApifyInstagramScraper({ token }),
  fetchMedia: media.fetchMedia,
  discardScratch: media.discardScratch,
  transcribe: async (path, model) => {
    progress(`transcribing with ${model} …`);
    return transcribe(path, model);
  },
  readText: {
    video: async (path, sampling, languages) => {
      progress(`reading on-screen text (${languages.join('+')}) …`);
      return reader.video(path, sampling, languages);
    },
    images: async (paths, languages) => {
      progress(`reading text in ${paths.length} image(s) (${languages.join('+')}) …`);
      return reader.images(paths, languages);
    },
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
