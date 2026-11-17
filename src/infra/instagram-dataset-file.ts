// ─── Saved Apify dataset (file adapter for the scrape port) ───────────────────
//
// Re-reads the JSON an earlier `apify/instagram-scraper` run produced (the dataset items, as
// downloaded from `GET /datasets/{id}/items?format=json`) instead of scraping again: no Apify
// credit, no wait. The rows are passed on raw — parsing them is the core's job, exactly as
// for a live scrape. Their signed media URLs expire about two days after the scrape.

import { promises as fs } from 'node:fs';
import { z } from 'zod';
import type { InstagramIngestPorts } from '../core/instagram-ingest.js';
import { type Result, err, ok } from '../core/types.js';

const DatasetSchema = z.array(z.unknown());

const readDataset = async (path: string): Promise<Result<readonly unknown[], string>> => {
  let text: string;
  try {
    text = await fs.readFile(path, 'utf8');
  } catch (e) {
    return err(`Cannot read dataset ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return err(`Dataset ${path} is not JSON`);
  }
  const rows = DatasetSchema.safeParse(raw);
  return rows.success ? ok(rows.data) : err(`Dataset ${path} is not a JSON array of items`);
};

/** A scrape port that serves the rows of a saved dataset file, in file order. */
export const createDatasetFileScraper =
  (path: string): InstagramIngestPorts['scrape'] =>
  () =>
    readDataset(path);
