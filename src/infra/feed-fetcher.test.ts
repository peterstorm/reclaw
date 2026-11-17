import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchFeeds } from './feed-fetcher.js';

const RSS = `<?xml version="1.0"?><rss><channel>
<item><title>Evals first</title><link>https://example.test/evals</link>
<pubDate>Mon, 16 Nov 2026 10:00:00 GMT</pubDate><description>Read your traces.</description></item>
</channel></rss>`;

let server: Server;
let base = '';
const agents: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    agents.push(req.headers['user-agent'] ?? '');
    if (req.url === '/feed') {
      res.writeHead(200, { 'content-type': 'application/rss+xml' }).end(RSS);
    } else if (req.url === '/slow') {
      setTimeout(() => res.writeHead(200).end(RSS), 2_000);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe('fetchFeeds', () => {
  it('parses each feed and reports failures per feed instead of throwing', async () => {
    const results = await fetchFeeds(
      [
        { source: 'good', url: `${base}/feed` },
        { source: 'gone', url: `${base}/missing` },
        { source: 'slow', url: `${base}/slow` },
      ],
      { timeoutMs: 300, userAgent: 'feed-fetcher-test/1' },
    );
    expect(results.map((r) => [r.feed.source, r.items.length, r.error === null])).toEqual([
      ['good', 1, true],
      ['gone', 0, false],
      ['slow', 0, false],
    ]);
    expect(results[0]?.items[0]).toMatchObject({
      source: 'good',
      title: 'Evals first',
      link: 'https://example.test/evals',
      date: '2026-11-16T10:00:00.000Z',
    });
    expect(results[1]?.error).toBe('HTTP 404');
    expect(agents).toContain('feed-fetcher-test/1');
  });
});
