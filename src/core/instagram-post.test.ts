import { describe, expect, it } from 'vitest';
import { rawSidecarItem, rawVideoItem } from './__fixtures__/instagram.js';
import { parseInstagramPost, partitionPosts } from './instagram-post.js';

describe('parseInstagramPost', () => {
  it('parses a video row into a video post', () => {
    const r = parseInstagramPost(rawVideoItem());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      shortCode: 'Db4K_XVyZOB',
      owner: 'bashi_fuirkashi',
      postedAt: '2026-08-10T23:15:04.000Z',
      likes: 112,
      comments: 78,
      media: { kind: 'video', durationSeconds: 33.4 },
    });
  });

  it('parses a carousel without a video as no-video', () => {
    const r = parseInstagramPost(rawSidecarItem());
    expect(r.ok && r.value.media).toEqual({ kind: 'no-video' });
  });

  it('treats hidden (-1) counts and a missing caption as unknown/empty', () => {
    const r = parseInstagramPost(
      rawVideoItem({ likesCount: -1, commentsCount: null, caption: null }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.likes).toBeNull();
      expect(r.value.comments).toBeNull();
      expect(r.value.caption).toBe('');
    }
  });

  it('keeps the video but drops a missing audio URL', () => {
    const r = parseInstagramPost(rawVideoItem({ audioUrl: '' }));
    expect(r.ok && r.value.media).toMatchObject({ kind: 'video', audioUrl: null });
  });

  it('surfaces scraper error rows with their description', () => {
    const r = parseInstagramPost({ error: 'no_items', errorDescription: 'Empty or private data' });
    expect(r).toEqual({ ok: false, error: 'scraper reported no_items: Empty or private data' });
  });

  it.each([
    [{ ...rawVideoItem(), timestamp: 'yesterday-ish' }, /timestamp/],
    [{ ...rawVideoItem(), shortCode: '../etc' }, /shortcode/i],
    [{ ...rawVideoItem(), ownerUsername: 'has space' }, /username/i],
    [{ foo: 1 }, /unexpected item shape/],
    [null, /unexpected item shape/],
  ])('rejects malformed row %#', (raw, message) => {
    const r = parseInstagramPost(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(message);
  });
});

describe('partitionPosts', () => {
  it('separates posts from rejected rows and keeps run order', () => {
    const { posts, rejected } = partitionPosts([
      rawVideoItem({ shortCode: 'AAAAA1' }),
      { error: 'no_items' },
      rawSidecarItem({ shortCode: 'BBBBB2' }),
    ]);
    expect(posts.map((p) => p.shortCode)).toEqual(['AAAAA1', 'BBBBB2']);
    expect(rejected).toEqual([{ index: 1, reason: 'scraper reported no_items' }]);
  });

  it('collapses duplicate shortcodes to the first occurrence', () => {
    const { posts } = partitionPosts([
      rawVideoItem({ caption: 'first' }),
      rawVideoItem({ caption: 'second' }),
    ]);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.caption).toBe('first');
  });
});
