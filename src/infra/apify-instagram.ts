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

const PENDING_STATUSES: ReadonlySet<string> = new Set(['READY', 'RUNNING', 'ABORTING']);

/** Apify's run status, folded to what the poll loop needs; any other status is terminal failure. */
const classifyRunStatus = (status: string): RunStatus => {
  if (status === 'SUCCEEDED') return 'succeeded';
  return PENDING_STATUSES.has(status) ? 'pending' : 'failed';
};

/** What every Apify request needs: the fetch to send it with and the authenticated headers. */
type ApifyClient = Readonly<{
  fetchFn: HttpFetch;
  headers: Readonly<Record<string, string>>;
}>;

/** One authenticated request, parsed with `schema`. HTTP bodies never echo the token. */
async function call<T>(
  client: ApifyClient,
  url: string,
  init: RequestInit,
  schema: z.ZodType<T>,
): Promise<Result<T, string>> {
  const response = await client.fetchFn(url, { ...init, headers: client.headers });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    return err(`Apify HTTP ${response.status}: ${body}`);
  }
  const parsed = schema.safeParse(await response.json());
  return parsed.success
    ? ok(parsed.data)
    : err(`Unexpected Apify response: ${parsed.error.issues[0]?.message ?? '?'}`);
}

/** Long-poll run `id` from `status` until it succeeds; a failed end or a passed deadline is an error. */
async function awaitRunSuccess(
  client: ApifyClient,
  id: string,
  status: string,
  deadline: number,
): Promise<Result<void, string>> {
  let current = status;
  while (classifyRunStatus(current) === 'pending') {
    if (Date.now() > deadline) return err(`Apify run ${id} did not finish in time.`);
    const polled = await call(
      client,
      `${API}/actor-runs/${id}?waitForFinish=${POLL_SECONDS}`,
      { method: 'GET' },
      RunSchema,
    );
    if (!polled.ok) return polled;
    current = polled.value.data.status;
  }
  if (classifyRunStatus(current) === 'failed') return err(`Apify run ${id} ended as ${current}.`);
  return ok(undefined);
}

export function createApifyInstagramScraper(
  config: ApifyScraperConfig,
): InstagramIngestPorts['scrape'] {
  const client: ApifyClient = {
    fetchFn: config.fetchFn ?? fetch,
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    },
  };
  const runDeadlineMs = config.runDeadlineMs ?? DEFAULT_RUN_DEADLINE_MS;

  return async (target, limit, budgetUsd) => {
    const input = { directUrls: [target.url], resultsType: 'posts', resultsLimit: limit };
    const started = await call(
      client,
      `${API}/acts/${ACTOR}/runs?maxTotalChargeUsd=${budgetUsd}`,
      { method: 'POST', body: JSON.stringify(input) },
      RunSchema,
    );
    if (!started.ok) return started;

    const { id, status, defaultDatasetId } = started.value.data;
    const finished = await awaitRunSuccess(client, id, status, Date.now() + runDeadlineMs);
    if (!finished.ok) return finished;

    return call(
      client,
      `${API}/datasets/${defaultDatasetId}/items?format=json&clean=true`,
      { method: 'GET' },
      ItemsSchema,
    );
  };
}
