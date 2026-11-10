import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InstagramUsername, ShortCode } from '../core/instagram-target.js';
import { createMediaFetcher } from './instagram-media.js';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'ig-media-test-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const owner = unwrap(InstagramUsername('someone'));
const shortCode = unwrap(ShortCode('Db4K_XVyZOB'));

const respond =
  (body: string, status = 200) =>
  async () =>
    new Response(body, { status });

describe('createMediaFetcher', () => {
  it('stores kept videos at <library>/<owner>/<shortcode>.mp4', async () => {
    const { fetchMedia } = createMediaFetcher({
      libraryDir: join(root, 'lib'),
      fetchFn: respond('VIDEO'),
    });
    const result = await fetchMedia('https://cdn.example/v.mp4', {
      kind: 'library',
      owner,
      shortCode,
    });
    expect(result).toEqual({ ok: true, value: join(root, 'lib', 'someone', 'Db4K_XVyZOB.mp4') });
    expect(await fs.readFile(join(root, 'lib', 'someone', 'Db4K_XVyZOB.mp4'), 'utf8')).toBe(
      'VIDEO',
    );
  });

  it('downloads scratch media into a private temp dir that discardScratch removes entirely', async () => {
    const { fetchMedia, discardScratch } = createMediaFetcher({
      libraryDir: join(root, 'lib'),
      scratchDir: root,
      fetchFn: respond('AUDIO'),
    });
    const result = await fetchMedia('https://cdn.example/a.mp4', { kind: 'scratch' });
    if (!result.ok) throw new Error(result.error);
    expect(await fs.readFile(result.value, 'utf8')).toBe('AUDIO');

    await discardScratch(result.value);
    await expect(fs.stat(result.value)).rejects.toThrow();
    await expect(fs.stat(join(result.value, '..'))).rejects.toThrow();
  });

  it('explains expired signed URLs (403)', async () => {
    const { fetchMedia } = createMediaFetcher({ libraryDir: root, fetchFn: respond('no', 403) });
    const result = await fetchMedia('https://cdn.example/v.mp4', { kind: 'scratch' });
    expect(result).toEqual({
      ok: false,
      error: 'Media download returned HTTP 403 (signed URL expired?)',
    });
  });

  it('refuses non-https URLs without making a request', async () => {
    const { fetchMedia } = createMediaFetcher({
      libraryDir: root,
      fetchFn: async () => {
        throw new Error('should not be called');
      },
    });
    expect(await fetchMedia('http://cdn.example/v.mp4', { kind: 'scratch' })).toEqual({
      ok: false,
      error: 'Refusing non-https media URL.',
    });
  });

  it('turns a network failure into an error result', async () => {
    const { fetchMedia } = createMediaFetcher({
      libraryDir: root,
      fetchFn: async () => {
        throw new Error('ECONNRESET');
      },
    });
    const result = await fetchMedia('https://cdn.example/v.mp4', { kind: 'scratch' });
    expect(result).toEqual({ ok: false, error: 'Media request failed: ECONNRESET' });
  });
});
