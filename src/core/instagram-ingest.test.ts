import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROFILE_LIMIT,
  INGEST_USAGE,
  type IngestReport,
  MAX_DATASET_POSTS,
  parseIngestArgs,
  planMedia,
  scrapeBudgetUsd,
  summarizeReport,
} from './instagram-ingest.js';
import { ShortCode } from './instagram-target.js';
import type { VaultRelativePath } from './vault-path.js';

const parsed = (args: string[]) => {
  const r = parseIngestArgs(args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe('parseIngestArgs', () => {
  it('defaults a post URL to one post, no video, small model, reading on-screen text', () => {
    const r = parsed(['https://www.instagram.com/reel/Db4K_XVyZOB/']);
    expect(r).toMatchObject({
      limit: 1,
      keepVideo: false,
      force: false,
      model: 'small',
      readScreenText: true,
    });
    expect(r.target.kind).toBe('post');
  });

  it('turns on-screen text reading off with --no-screen-text', () => {
    expect(parsed(['@someone', '--no-screen-text']).readScreenText).toBe(false);
  });

  it('defaults a profile to the standard limit', () => {
    expect(parsed(['@someone']).limit).toBe(DEFAULT_PROFILE_LIMIT);
  });

  it('reads flags in any position', () => {
    const r = parsed(['--video', '@someone', '--limit', '5', '--force', '--model', 'medium']);
    expect(r).toMatchObject({ limit: 5, keepVideo: true, force: true, model: 'medium' });
  });

  it('scrapes unless told to read a saved dataset', () => {
    expect(parsed(['@someone']).source).toEqual({ kind: 'scrape' });
  });

  it('reads a saved dataset whole by default, beyond the scrape cap', () => {
    const r = parsed(['@someone', '--from-dataset', '/tmp/items.json']);
    expect(r.source).toEqual({ kind: 'dataset', path: '/tmp/items.json' });
    expect(r.limit).toBe(MAX_DATASET_POSTS);
    expect(parsed(['@someone', '--from-dataset', 'f.json', '--limit', '250']).limit).toBe(250);
  });

  it('uses the injected default model', () => {
    const r = parseIngestArgs(['@someone'], 'medium');
    expect(r.ok && r.value.model).toBe('medium');
  });

  it.each([
    [[], /usage/i],
    [['@a', '@b'], /usage/i],
    [['@someone', '--limit'], /needs a value/],
    [['@someone', '--limit', '0'], /positive integer/],
    [['@someone', '--limit', '201'], /1 to 200 when scraping/],
    [['@someone', '--limit', 'ten'], /integer/],
    [['@someone', '--from-dataset', 'f.json', '--limit', '10001'], /1 to 10000 for a dataset/],
    [['@someone', '--from-dataset'], /needs a value/],
    [['@someone', '--from-dataset', ' '], /needs a file path/],
    [['https://www.instagram.com/p/Db4K_XVyZOB/', '--from-dataset', 'f.json'], /@handle/],
    [['@someone', '--model', 'huge'], /Invalid model/],
    [['@someone', '--wat'], /Unknown option/],
    [['https://www.instagram.com/p/Db4K_XVyZOB/', '--limit', '3'], /only applies to profiles/],
    [['https://example.com/x'], /Not an Instagram URL/],
  ])('rejects %j', (args, message) => {
    const r = parseIngestArgs(args);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(message);
  });

  const POST = 'https://www.instagram.com/p/Db4K_XVyZOB/';

  // Exact texts, and which check wins when several apply: flag values are parsed first,
  // then the target, then the post-URL rules, then the source's limit cap.
  it.each([
    [
      ['@someone', '--limit', '201'],
      '--limit must be from 1 to 200 when scraping (each post costs Apify credit), got 201.',
    ],
    [['@someone', '--limit', '200'], null],
    [
      ['@someone', '--from-dataset', 'f.json', '--limit', '10001'],
      '--limit must be from 1 to 10000 for a dataset, got 10001.',
    ],
    [['@someone', '--from-dataset', 'f.json', '--limit', '10000'], null],
    [['@someone', '--limit'], `--limit needs a value. ${INGEST_USAGE}`],
    [['@someone', '--model'], `--model needs a value. ${INGEST_USAGE}`],
    [['@someone', '--from-dataset'], `--from-dataset needs a value. ${INGEST_USAGE}`],
    [['@someone', '--limit', 'ten'], '--limit must be a positive integer, got "ten".'],
    [['@someone', '--limit', '2.5'], '--limit must be a positive integer, got "2.5".'],
    [['@someone', '--limit', '0'], '--limit must be a positive integer, got "0".'],
    [['--limit', 'ten'], '--limit must be a positive integer, got "ten".'],
    [[POST, '--limit', '3'], '--limit only applies to profiles; a post URL is always one post.'],
    [[POST, '--limit', '999'], '--limit only applies to profiles; a post URL is always one post.'],
    [
      [POST, '--from-dataset', 'f.json'],
      '--from-dataset ingests a saved profile dataset; give the @handle, not a post URL.',
    ],
    [
      [POST, '--limit', '3', '--from-dataset', 'f.json'],
      '--limit only applies to profiles; a post URL is always one post.',
    ],
  ])('reports exactly what is wrong with %j', (args, expected) => {
    const r = parseIngestArgs(args);
    if (expected === null) expect(r.ok).toBe(true);
    else expect(r).toEqual({ ok: false, error: expected });
  });
});

describe('planMedia', () => {
  const media = { kind: 'video', videoUrl: 'V', audioUrl: 'A', durationSeconds: 1 } as const;

  it('keeps the video when asked', () => {
    expect(planMedia(media, true, true)).toEqual({ kind: 'keep-video', url: 'V' });
    expect(planMedia(media, true, false)).toEqual({ kind: 'keep-video', url: 'V' });
  });

  it('needs the picture to read on-screen text', () => {
    expect(planMedia(media, false, true)).toEqual({ kind: 'scratch', url: 'V' });
  });

  it('takes the smaller audio track when only transcribing', () => {
    expect(planMedia(media, false, false)).toEqual({ kind: 'scratch', url: 'A' });
  });

  it('falls back to the video when there is no audio URL', () => {
    expect(planMedia({ ...media, audioUrl: null }, false, false)).toEqual({
      kind: 'scratch',
      url: 'V',
    });
  });
});

describe('scrapeBudgetUsd', () => {
  it('scales with the limit but never below the floor', () => {
    expect(scrapeBudgetUsd(1)).toBe(0.05);
    expect(scrapeBudgetUsd(100)).toBe(1);
  });
});

describe('summarizeReport', () => {
  const code = (raw: string) => {
    const r = ShortCode(raw);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  const path = 'media/instagram/a/b.md' as VaultRelativePath;

  it('counts each outcome kind', () => {
    const report = {
      request: parsed(['@someone']),
      outcomes: [
        {
          kind: 'saved',
          shortCode: code('AAAAA'),
          notePath: path,
          transcribed: true,
          textRead: true,
          videoPath: null,
        },
        {
          kind: 'saved',
          shortCode: code('BBBBB'),
          notePath: path,
          transcribed: false,
          textRead: false,
          videoPath: null,
        },
        { kind: 'skipped-existing', shortCode: code('CCCCC'), notePath: path },
        { kind: 'failed', shortCode: code('DDDDD'), stage: 'download', reason: 'x' },
      ],
      rejected: [{ index: 4, reason: 'y' }],
      warnings: [],
    } satisfies IngestReport;
    expect(summarizeReport(report)).toEqual({
      saved: 2,
      transcribed: 1,
      textRead: 1,
      skippedExisting: 1,
      failed: 1,
      rejected: 1,
    });
  });
});
