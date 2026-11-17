import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseInstagramTarget } from '../core/instagram-target.js';
import { createDatasetFileScraper } from './instagram-dataset-file.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'ig-dataset-test-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const target = (() => {
  const t = parseInstagramTarget('@someone');
  if (!t.ok) throw new Error(t.error);
  return t.value;
})();

const scrapeFile = async (name: string, content: string | null) => {
  const path = join(dir, name);
  if (content !== null) await fs.writeFile(path, content);
  return createDatasetFileScraper(path)(target, 20, 0.2);
};

describe('createDatasetFileScraper', () => {
  it('serves the saved rows raw and in file order', async () => {
    const rows = [{ shortCode: 'A1' }, { shortCode: 'B2', extra: [1, 2] }, 'odd row'];
    expect(await scrapeFile('items.json', JSON.stringify(rows))).toEqual({ ok: true, value: rows });
  });

  it.each([
    ['a missing file', null, /Cannot read dataset/],
    ['a file that is not JSON', '{nope', /is not JSON/],
    ['JSON that is not an array', '{"items": []}', /not a JSON array/],
  ])('reports %s as an error, not a throw', async (_, content, message) => {
    const result = await scrapeFile('items.json', content);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(message);
  });
});
