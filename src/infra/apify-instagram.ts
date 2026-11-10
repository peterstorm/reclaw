// ─── Apify Instagram scraper (HTTP adapter) ───────────────────────────────────
//
// Anti-corruption layer over Apify's REST API for `apify/instagram-scraper`. Runs are
// started asynchronously and long-polled (waitForFinish), so profile scrapes that outlast the
// 5-minute sync-endpoint cap still complete. The per-run `maxTotalChargeUsd` is the cost guard.
// Docs: https://docs.apify.com/api/v2 — `POST /acts/{id}/runs`, `GET /actor-runs/{id}`,
// `GET /datasets/{id}/items`.

import { z } from 'zod';
import type { InstagramIngestPorts } from '../core/instagram-ingest.js';
import { type Result, err, ok } from '../core/types.js';
import type { HttpFetch } from './http-fetch.js';

const API = 'https://api.apify.com/v2';
const ACTOR = 'apify~instagram-scraper';

/** Seconds per long-poll (Apify caps waitForFinish at 60). */
const POLL_SECONDS = 60;
const DEFAULT_RUN_DEADLINE_MS = 20 * 60 * 1000;

const RunSchema = z.object({
  data: z.object({
    id: z.string(),
    status: z.string(),
    defaultDatasetId: z.string(),
  }),
});

const ItemsSchema = z.array(z.unknown());

export type ApifyScraperConfig = Readonly<{
  token: string;
  fetchFn?: HttpFetch;
  runDeadlineMs?: number;
}>;

type RunStatus = 'pending' | 'succeeded' | 'failed';

const classifyRunStatus = (status: string): RunStatus =>
  status === 'SUCCEEDED'
    ? 'succeeded'
    : status === 'READY' || status === 'RUNNING' || status === 'ABORTING'
      ? 'pending'
      : 'failed';

export function createApifyInstagramScraper(
  config: ApifyScraperConfig,
): InstagramIngestPorts['scrape'] {
  const fetchFn = config.fetchFn ?? fetch;
  const headers = {
    Authorization: `Bearer ${config.token}`,
    'Content-Type': 'application/json',
  };

  /** One authenticated request, parsed with `schema`. HTTP bodies never echo the token. */
  const call = async <T>(
    url: string,
    init: RequestInit,
    schema: z.ZodType<T>,
  ): Promise<Result<T, string>> => {
    const response = await fetchFn(url, { ...init, headers });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 300);
      return err(`Apify HTTP ${response.status}: ${body}`);
    }
    const parsed = schema.safeParse(await response.json());
    return parsed.success
      ? ok(parsed.data)
      : err(`Unexpected Apify response: ${parsed.error.issues[0]?.message ?? '?'}`);
  };

  return async (target, limit, budgetUsd) => {
    const input = { directUrls: [target.url], resultsType: 'posts', resultsLimit: limit };
    const started = await call(
      `${API}/acts/${ACTOR}/runs?maxTotalChargeUsd=${budgetUsd}`,
      { method: 'POST', body: JSON.stringify(input) },
      RunSchema,
    );
    if (!started.ok) return started;

    const { id, defaultDatasetId } = started.value.data;
    let status = started.value.data.status;
    const deadline = Date.now() + (config.runDeadlineMs ?? DEFAULT_RUN_DEADLINE_MS);

    while (classifyRunStatus(status) === 'pending') {
      if (Date.now() > deadline) return err(`Apify run ${id} did not finish in time.`);
      const polled = await call(
        `${API}/actor-runs/${id}?waitForFinish=${POLL_SECONDS}`,
        { method: 'GET' },
        RunSchema,
      );
      if (!polled.ok) return polled;
      status = polled.value.data.status;
    }
    if (classifyRunStatus(status) === 'failed') return err(`Apify run ${id} ended as ${status}.`);

    return call(
      `${API}/datasets/${defaultDatasetId}/items?format=json&clean=true`,
      { method: 'GET' },
      ItemsSchema,
    );
  };
}
