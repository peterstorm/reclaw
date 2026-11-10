import { describe, expect, it } from 'vitest';
import { parseInstagramTarget } from '../core/instagram-target.js';
import { createApifyInstagramScraper } from './apify-instagram.js';

const target = (() => {
  const r = parseInstagramTarget('https://www.instagram.com/reel/Db4K_XVyZOB/');
  if (!r.ok) throw new Error(r.error);
  return r.value;
})();

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const run = (status: string) => ({ data: { id: 'run1', status, defaultDatasetId: 'ds1' } });

/** Scripted fetch: answers in order and records every request. */
const scripted = (...responses: Response[]) => {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const queue = [...responses];
  const fetchFn = async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    const next = queue.shift();
    if (next === undefined) throw new Error(`unexpected request to ${url}`);
    return next;
  };
  return { fetchFn, requests };
};

describe('createApifyInstagramScraper', () => {
  it('starts a capped run, long-polls to completion, then returns dataset items', async () => {
    const items = [{ shortCode: 'Db4K_XVyZOB' }];
    const { fetchFn, requests } = scripted(
      json(run('READY')),
      json(run('RUNNING')),
      json(run('SUCCEEDED')),
      json(items),
    );
    const scrape = createApifyInstagramScraper({ token: 'tok', fetchFn });

    expect(await scrape(target, 1, 0.05)).toEqual({ ok: true, value: items });

    expect(requests.map((r) => r.url)).toEqual([
      'https://api.apify.com/v2/acts/apify~instagram-scraper/runs?maxTotalChargeUsd=0.05',
      'https://api.apify.com/v2/actor-runs/run1?waitForFinish=60',
      'https://api.apify.com/v2/actor-runs/run1?waitForFinish=60',
      'https://api.apify.com/v2/datasets/ds1/items?format=json&clean=true',
    ]);
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      directUrls: ['https://www.instagram.com/reel/Db4K_XVyZOB/'],
      resultsType: 'posts',
      resultsLimit: 1,
    });
  });

  it('authenticates with a bearer header, never a URL parameter', async () => {
    const { fetchFn, requests } = scripted(json(run('SUCCEEDED')), json([]));
    await createApifyInstagramScraper({ token: 'secret-token', fetchFn })(target, 1, 0.05);
    for (const r of requests) {
      expect(r.url).not.toContain('secret-token');
      expect((r.init?.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
    }
  });

  it.each(['FAILED', 'ABORTED', 'TIMED-OUT'])('reports a %s run', async (status) => {
    const { fetchFn } = scripted(json(run('RUNNING')), json(run(status)));
    const r = await createApifyInstagramScraper({ token: 't', fetchFn })(target, 1, 0.05);
    expect(r).toEqual({ ok: false, error: `Apify run run1 ended as ${status}.` });
  });

  it('surfaces HTTP errors with a bounded body, not a thrown exception', async () => {
    const { fetchFn } = scripted(new Response('Insufficient credit', { status: 402 }));
    const r = await createApifyInstagramScraper({ token: 't', fetchFn })(target, 1, 0.05);
    expect(r).toEqual({ ok: false, error: 'Apify HTTP 402: Insufficient credit' });
  });

  it('rejects an unexpected response shape', async () => {
    const { fetchFn } = scripted(json({ nope: true }));
    const r = await createApifyInstagramScraper({ token: 't', fetchFn })(target, 1, 0.05);
    expect(r.ok).toBe(false);
  });

  it('gives up when the run outlives its deadline', async () => {
    const { fetchFn } = scripted(json(run('RUNNING')));
    const r = await createApifyInstagramScraper({ token: 't', fetchFn, runDeadlineMs: -1 })(
      target,
      1,
      0.05,
    );
    expect(r).toEqual({ ok: false, error: 'Apify run run1 did not finish in time.' });
  });
});
