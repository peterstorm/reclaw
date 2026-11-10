// ─── Instagram media fetcher (HTTP + filesystem adapter) ──────────────────────
//
// Downloads signed Instagram CDN URLs to disk. Those URLs expire within ~2 days, so callers
// must fetch in the same run as the scrape. Files land via tmp + rename; a failed download
// never leaves a partial file at the final path.

import { promises as fs, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { MediaTarget } from '../core/instagram-ingest.js';
import { type Result, err, ok } from '../core/types.js';
import type { HttpFetch } from './http-fetch.js';

export type MediaFetcherConfig = Readonly<{
  /** Where kept videos live: `<libraryDir>/<owner>/<shortcode>.mp4`. Outside the vault. */
  libraryDir: string;
  /** Parent for throwaway downloads. Defaults to the OS temp dir. */
  scratchDir?: string;
  fetchFn?: HttpFetch;
}>;

const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

export function createMediaFetcher(config: MediaFetcherConfig) {
  const fetchFn = config.fetchFn ?? fetch;

  const destinationFor = async (to: MediaTarget): Promise<string> => {
    if (to.kind === 'library') {
      const dir = path.join(config.libraryDir, to.owner);
      await fs.mkdir(dir, { recursive: true });
      return path.join(dir, `${to.shortCode}.mp4`);
    }
    const dir = await fs.mkdtemp(path.join(config.scratchDir ?? tmpdir(), 'ig-media-'));
    return path.join(dir, 'media.mp4');
  };

  const fetchMedia = async (url: string, to: MediaTarget): Promise<Result<string, string>> => {
    if (!url.startsWith('https://')) return err('Refusing non-https media URL.');

    let response: Response;
    try {
      response = await fetchFn(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    } catch (e) {
      return err(`Media request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!response.ok || response.body === null) {
      const hint = response.status === 403 ? ' (signed URL expired?)' : '';
      return err(`Media download returned HTTP ${response.status}${hint}`);
    }

    const destination = await destinationFor(to);
    const temp = `${destination}.${process.pid}.part`;
    try {
      await pipeline(Readable.fromWeb(response.body as never), createWriteStream(temp));
      await fs.rename(temp, destination);
      return ok(destination);
    } catch (e) {
      await fs.rm(temp, { force: true });
      return err(`Writing media failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** Remove a scratch download together with its private temp directory. */
  const discardScratch = async (file: string): Promise<void> => {
    await fs.rm(path.dirname(file), { recursive: true, force: true });
  };

  return { fetchMedia, discardScratch };
}
