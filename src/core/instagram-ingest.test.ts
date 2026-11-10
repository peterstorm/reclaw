import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROFILE_LIMIT,
  type IngestReport,
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
  it('defaults a post URL to one post, no video, small model', () => {
    const r = parsed(['https://www.instagram.com/reel/Db4K_XVyZOB/']);
    expect(r).toMatchObject({ limit: 1, keepVideo: false, force: false, model: 'small' });
    expect(r.target.kind).toBe('post');
  });

  it('defaults a profile to the standard limit', () => {
    expect(parsed(['@someone']).limit).toBe(DEFAULT_PROFILE_LIMIT);
  });

  it('reads flags in any position', () => {
    const r = parsed(['--video', '@someone', '--limit', '5', '--force', '--model', 'medium']);
    expect(r).toMatchObject({ limit: 5, keepVideo: true, force: true, model: 'medium' });
  });

  it('uses the injected default model', () => {
    const r = parseIngestArgs(['@someone'], 'medium');
    expect(r.ok && r.value.model).toBe('medium');
  });

  it.each([
    [[], /usage/i],
    [['@a', '@b'], /usage/i],
    [['@someone', '--limit'], /needs a value/],
    [['@someone', '--limit', '0'], /1 to 200/],
    [['@someone', '--limit', '201'], /1 to 200/],
    [['@someone', '--limit', 'ten'], /integer/],
    [['@someone', '--model', 'huge'], /Invalid model/],
    [['@someone', '--wat'], /Unknown option/],
    [['https://www.instagram.com/p/Db4K_XVyZOB/', '--limit', '3'], /only applies to profiles/],
    [['https://example.com/x'], /Not an Instagram URL/],
  ])('rejects %j', (args, message) => {
    const r = parseIngestArgs(args);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(message);
  });
});

describe('planMedia', () => {
  const media = { kind: 'video', videoUrl: 'V', audioUrl: 'A', durationSeconds: 1 } as const;

  it('keeps the video when asked', () => {
    expect(planMedia(media, true)).toEqual({ kind: 'keep-video', url: 'V' });
  });

  it('prefers the smaller audio track for scratch transcription', () => {
    expect(planMedia(media, false)).toEqual({ kind: 'scratch', url: 'A' });
  });

  it('falls back to the video when there is no audio URL', () => {
    expect(planMedia({ ...media, audioUrl: null }, false)).toEqual({ kind: 'scratch', url: 'V' });
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
          videoPath: null,
        },
        {
          kind: 'saved',
          shortCode: code('BBBBB'),
          notePath: path,
          transcribed: false,
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
      skippedExisting: 1,
      failed: 1,
      rejected: 1,
    });
  });
});
