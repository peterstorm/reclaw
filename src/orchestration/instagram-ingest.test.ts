import { describe, expect, it } from 'vitest';
import {
  ocrLine,
  rawSidecarItem,
  rawVideoItem,
  reading,
  sampleTranscript,
} from '../core/__fixtures__/instagram.js';
import {
  type IngestRequest,
  type InstagramIngestPorts,
  type MediaTarget,
  parseIngestArgs,
} from '../core/instagram-ingest.js';
import type {
  FrameReading,
  FrameSampling,
  ImageReading,
  OcrLanguage,
} from '../core/instagram-screen-text.js';
import type { Transcript } from '../core/instagram-transcript.js';
import { type Result, err, ok } from '../core/types.js';
import { ingestInstagram } from './instagram-ingest.js';

const request = (...args: string[]): IngestRequest => {
  const r = parseIngestArgs(args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

type FakeOptions = {
  items?: readonly unknown[];
  scrapeError?: string;
  seedVault?: Record<string, string>;
  failDownloadFor?: (url: string) => boolean;
  transcribeResult?: Result<Transcript, string>;
  videoTextResult?: Result<readonly FrameReading[], string>;
  imageTextResult?: Result<readonly ImageReading[], string>;
  failWriteTo?: (path: string) => boolean;
};

const titleFrames: readonly FrameReading[] = [0, 1, 2].map((atSeconds) => ({
  atSeconds,
  reading: reading(ocrLine('Seven habits list')),
}));

/** In-memory ports: plain object literals, no mocking framework. */
const fakePorts = (options: FakeOptions = {}) => {
  const files = new Map<string, string>(Object.entries(options.seedVault ?? {}));
  const downloads: { url: string; to: MediaTarget }[] = [];
  const discarded: string[] = [];
  const transcribed: { path: string; model: string }[] = [];
  const scrapes: { limit: number; budgetUsd: number }[] = [];
  const videoReads: { path: string; sampling: FrameSampling; languages: readonly OcrLanguage[] }[] =
    [];
  const imageReads: { paths: readonly string[]; languages: readonly OcrLanguage[] }[] = [];
  let scratchCount = 0;

  const ports: InstagramIngestPorts = {
    scrape: async (_target, limit, budgetUsd) => {
      scrapes.push({ limit, budgetUsd });
      return options.scrapeError === undefined ? ok(options.items ?? []) : err(options.scrapeError);
    },
    fetchMedia: async (url, to) => {
      downloads.push({ url, to });
      if (options.failDownloadFor?.(url)) return err('HTTP 403 (signed URL expired?)');
      if (to.kind === 'library') return ok(`/library/${to.owner}/${to.shortCode}.mp4`);
      return ok(to.format === 'mp4' ? '/scratch/media.mp4' : `/scratch/${++scratchCount}.jpg`);
    },
    discardScratch: async (path) => {
      discarded.push(path);
    },
    transcribe: async (path, model) => {
      transcribed.push({ path, model });
      return options.transcribeResult ?? ok(sampleTranscript);
    },
    readText: {
      video: async (path, sampling, languages) => {
        videoReads.push({ path, sampling, languages });
        return options.videoTextResult ?? ok(titleFrames);
      },
      images: async (paths, languages) => {
        imageReads.push({ paths, languages });
        return (
          options.imageTextResult ??
          ok(paths.map((_, i) => reading(ocrLine(`Slide ${i + 1} headline`))))
        );
      },
    },
    vault: {
      exists: async (path) => files.has(path),
      read: async (path) => files.get(path) ?? null,
      write: async (path, content) => {
        if (options.failWriteTo?.(path)) throw new Error('disk full');
        files.set(path, content);
      },
    },
    today: () => '2026-11-09',
  };
  return { ports, files, downloads, discarded, transcribed, scrapes, videoReads, imageReads };
};

const NOTE = 'media/instagram/bashi_fuirkashi/Db4K_XVyZOB.md';
const CHANGELOG = '# Changelog\n\n## 2026-11-08\n\n- x\n';
const reel = 'https://www.instagram.com/reel/Db4K_XVyZOB/';

describe('ingestInstagram — single reel', () => {
  it('scrapes, transcribes, reads on-screen text, writes the note, MOC and changelog', async () => {
    const fake = fakePorts({ items: [rawVideoItem()], seedVault: { 'changelog.md': CHANGELOG } });
    const result = await ingestInstagram(request(reel), fake.ports);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcomes).toEqual([
      {
        kind: 'saved',
        shortCode: 'Db4K_XVyZOB',
        notePath: NOTE,
        transcribed: true,
        textRead: true,
        videoPath: null,
      },
    ]);

    // The video (needed for its picture) went to scratch, was transcribed and read, then discarded.
    expect(fake.downloads).toEqual([
      { url: expect.stringContaining('video.mp4'), to: { kind: 'scratch', format: 'mp4' } },
    ]);
    expect(fake.transcribed).toEqual([{ path: '/scratch/media.mp4', model: 'small' }]);
    expect(fake.videoReads).toEqual([
      {
        path: '/scratch/media.mp4',
        sampling: { everySeconds: 1, maxFrames: 120 },
        languages: ['eng'],
      },
    ]);
    expect(fake.discarded).toEqual(['/scratch/media.mp4']);

    expect(fake.files.get(NOTE)).toContain(
      '## Transcript\n\n[0:00] I have been coding for six years.',
    );
    expect(fake.files.get(NOTE)).toContain('## On-screen text\n\n[0:00] Seven habits list');
    expect(fake.files.get('media/instagram/MOC.md')).toContain(
      '[[media/instagram/bashi_fuirkashi/Db4K_XVyZOB|',
    );
    expect(fake.files.get('changelog.md')).toContain(
      '## 2026-11-09\n\n- **added** [[media/instagram/bashi_fuirkashi/Db4K_XVyZOB]]',
    );
    expect(result.value.warnings).toEqual([]);
  });

  it('asks the scraper for exactly one post with a cost cap', async () => {
    const fake = fakePorts({ items: [rawVideoItem()] });
    await ingestInstagram(request(reel), fake.ports);
    expect(fake.scrapes).toEqual([{ limit: 1, budgetUsd: 0.05 }]);
  });

  it('keeps the mp4 in the video library with --video and does not discard it', async () => {
    const fake = fakePorts({ items: [rawVideoItem()] });
    const result = await ingestInstagram(request(reel, '--video'), fake.ports);

    expect(fake.downloads).toEqual([
      {
        url: expect.stringContaining('video.mp4'),
        to: { kind: 'library', owner: 'bashi_fuirkashi', shortCode: 'Db4K_XVyZOB' },
      },
    ]);
    expect(fake.discarded).toEqual([]);
    expect(result.ok && result.value.outcomes[0]).toMatchObject({
      kind: 'saved',
      videoPath: '/library/bashi_fuirkashi/Db4K_XVyZOB.mp4',
    });
    expect(fake.files.get(NOTE)).toContain('video: "/library/bashi_fuirkashi/Db4K_XVyZOB.mp4"');
  });

  it('passes the chosen model to the transcriber', async () => {
    const fake = fakePorts({ items: [rawVideoItem()] });
    await ingestInstagram(request(reel, '--model', 'medium'), fake.ports);
    expect(fake.transcribed[0]?.model).toBe('medium');
  });

  it('reads Danish reels with the Danish language pack', async () => {
    const fake = fakePorts({
      items: [rawVideoItem()],
      transcribeResult: ok({ language: 'da', segments: [] }),
    });
    await ingestInstagram(request(reel), fake.ports);
    expect(fake.videoReads[0]?.languages).toEqual(['dan', 'eng']);
  });

  it('with --no-screen-text, downloads only the audio and reads nothing', async () => {
    const fake = fakePorts({ items: [rawVideoItem()] });
    const result = await ingestInstagram(request(reel, '--no-screen-text'), fake.ports);
    expect(fake.downloads).toEqual([
      { url: expect.stringContaining('audio.mp4'), to: { kind: 'scratch', format: 'mp4' } },
    ]);
    expect(fake.videoReads).toEqual([]);
    expect(result.ok && result.value.outcomes[0]).toMatchObject({ kind: 'saved', textRead: false });
    expect(fake.files.get(NOTE)).not.toContain('## On-screen text');
  });

  it('reads the kept video in place with --video', async () => {
    const fake = fakePorts({ items: [rawVideoItem()] });
    await ingestInstagram(request(reel, '--video'), fake.ports);
    expect(fake.videoReads[0]?.path).toBe('/library/bashi_fuirkashi/Db4K_XVyZOB.mp4');
  });
});

describe('ingestInstagram — photos and carousels', () => {
  const carousel = 'https://www.instagram.com/p/DWg4jmJFQSp/';
  const CAROUSEL_NOTE = 'media/instagram/bashi_fuirkashi/DWg4jmJFQSp.md';

  it('downloads every image to scratch, reads them in one batch, and discards them', async () => {
    const fake = fakePorts({ items: [rawSidecarItem()] });
    const result = await ingestInstagram(request(carousel), fake.ports);

    expect(fake.downloads).toEqual([
      { url: 'https://cdn.example/1.jpg', to: { kind: 'scratch', format: 'jpg' } },
      { url: 'https://cdn.example/2.jpg', to: { kind: 'scratch', format: 'jpg' } },
    ]);
    expect(fake.imageReads).toEqual([
      { paths: ['/scratch/1.jpg', '/scratch/2.jpg'], languages: ['eng'] },
    ]);
    expect(fake.discarded).toEqual(['/scratch/1.jpg', '/scratch/2.jpg']);
    expect(fake.transcribed).toEqual([]);
    expect(result.ok && result.value.outcomes[0]).toMatchObject({
      kind: 'saved',
      transcribed: false,
      textRead: true,
    });
    expect(fake.files.get(CAROUSEL_NOTE)).toContain(
      '## Text in images\n\n**Image 1**\n\n- Slide 1 headline\n\n**Image 2**\n\n- Slide 2 headline',
    );
  });

  it('discards images already downloaded when a later one fails, and writes nothing', async () => {
    const fake = fakePorts({
      items: [rawSidecarItem()],
      failDownloadFor: (url) => url.endsWith('2.jpg'),
    });
    const result = await ingestInstagram(request(carousel), fake.ports);
    expect(result.ok && result.value.outcomes[0]).toMatchObject({
      kind: 'failed',
      stage: 'download',
    });
    expect(fake.discarded).toEqual(['/scratch/1.jpg']);
    expect(fake.files.has(CAROUSEL_NOTE)).toBe(false);
  });

  it('with --no-screen-text, writes a caption-only note without downloading', async () => {
    const fake = fakePorts({ items: [rawSidecarItem()] });
    await ingestInstagram(request(carousel, '--no-screen-text'), fake.ports);
    expect(fake.downloads).toEqual([]);
    expect(fake.files.get(CAROUSEL_NOTE)).not.toContain('## Text in images');
  });
});

describe('ingestInstagram — idempotency', () => {
  it('skips existing notes without downloading or transcribing', async () => {
    const fake = fakePorts({ items: [rawVideoItem()], seedVault: { [NOTE]: 'old' } });
    const result = await ingestInstagram(request(reel), fake.ports);

    expect(result.ok && result.value.outcomes).toEqual([
      { kind: 'skipped-existing', shortCode: 'Db4K_XVyZOB', notePath: NOTE },
    ]);
    expect(fake.downloads).toEqual([]);
    expect(fake.transcribed).toEqual([]);
    expect(fake.files.get(NOTE)).toBe('old');
    expect(fake.files.has('media/instagram/MOC.md')).toBe(false);
  });

  it('overwrites with --force', async () => {
    const fake = fakePorts({ items: [rawVideoItem()], seedVault: { [NOTE]: 'old' } });
    await ingestInstagram(request(reel, '--force'), fake.ports);
    expect(fake.files.get(NOTE)).toContain('## Transcript');
  });

  it('a second identical run changes nothing', async () => {
    const fake = fakePorts({ items: [rawVideoItem()], seedVault: { 'changelog.md': CHANGELOG } });
    await ingestInstagram(request(reel), fake.ports);
    const snapshot = new Map(fake.files);
    await ingestInstagram(request(reel), fake.ports);
    expect(fake.files).toEqual(snapshot);
  });
});

describe('ingestInstagram — profiles', () => {
  const items = [
    rawVideoItem({ shortCode: 'AAAAA1' }),
    rawSidecarItem({ shortCode: 'BBBBB2' }),
    rawVideoItem({ shortCode: 'CCCCC3' }),
  ];

  it('ingests videos and carousels side by side', async () => {
    const fake = fakePorts({ items });
    const result = await ingestInstagram(request('@bashi_fuirkashi', '--limit', '3'), fake.ports);

    expect(result.ok && result.value.outcomes.map((o) => o.kind)).toEqual([
      'saved',
      'saved',
      'saved',
    ]);
    expect(fake.transcribed).toHaveLength(2);
    expect(fake.files.get('media/instagram/bashi_fuirkashi/BBBBB2.md')).toContain(
      '## Text in images',
    );
    expect(fake.files.get('changelog.md')).toBeUndefined();
  });

  it('isolates a failed download and still saves the rest (re-run retries only the failure)', async () => {
    let downloads = 0;
    const fake = fakePorts({ items, failDownloadFor: () => ++downloads === 1 });

    const result = await ingestInstagram(request('@bashi_fuirkashi', '--limit', '3'), fake.ports);
    expect(result.ok && result.value.outcomes.map((o) => o.kind)).toEqual([
      'failed',
      'saved',
      'saved',
    ]);
    expect(result.ok && result.value.outcomes[0]).toMatchObject({
      stage: 'download',
      reason: expect.stringContaining('403'),
    });
    expect(fake.files.has('media/instagram/bashi_fuirkashi/AAAAA1.md')).toBe(false);

    // Re-run: the two saved notes are skipped, only the failed one is redone.
    const rerun = await ingestInstagram(request('@bashi_fuirkashi', '--limit', '3'), fake.ports);
    expect(rerun.ok && rerun.value.outcomes.map((o) => o.kind)).toEqual([
      'saved',
      'skipped-existing',
      'skipped-existing',
    ]);
  });

  it('truncates to the requested limit', async () => {
    const fake = fakePorts({ items });
    const result = await ingestInstagram(request('@bashi_fuirkashi', '--limit', '1'), fake.ports);
    expect(result.ok && result.value.outcomes).toHaveLength(1);
  });

  it('reports rejected scraper rows', async () => {
    const fake = fakePorts({ items: [{ error: 'no_items', errorDescription: 'private' }] });
    const result = await ingestInstagram(request('@someone'), fake.ports);
    expect(result.ok && result.value.outcomes).toEqual([]);
    expect(result.ok && result.value.rejected).toEqual([
      { index: 0, reason: 'scraper reported no_items: private' },
    ]);
  });
});

describe('ingestInstagram — failures', () => {
  it('fails the run when the scrape fails', async () => {
    const fake = fakePorts({ scrapeError: 'Apify HTTP 402: out of credit' });
    expect(await ingestInstagram(request(reel), fake.ports)).toEqual({
      ok: false,
      error: 'Scrape failed: Apify HTTP 402: out of credit',
    });
  });

  it('writes no note when transcription fails, and still discards the scratch file', async () => {
    const fake = fakePorts({
      items: [rawVideoItem()],
      transcribeResult: err('Whisper failed: boom'),
    });
    const result = await ingestInstagram(request(reel), fake.ports);
    expect(result.ok && result.value.outcomes).toEqual([
      {
        kind: 'failed',
        shortCode: 'Db4K_XVyZOB',
        stage: 'transcribe',
        reason: 'Whisper failed: boom',
      },
    ]);
    expect(fake.files.size).toBe(0);
    expect(fake.discarded).toEqual(['/scratch/media.mp4']);
  });

  it('writes no note when reading on-screen text fails, and still discards the video', async () => {
    const fake = fakePorts({
      items: [rawVideoItem()],
      videoTextResult: err('Reading text failed: tesseract exited 1'),
    });
    const result = await ingestInstagram(request(reel), fake.ports);
    expect(result.ok && result.value.outcomes).toEqual([
      {
        kind: 'failed',
        shortCode: 'Db4K_XVyZOB',
        stage: 'read-text',
        reason: 'Reading text failed: tesseract exited 1',
      },
    ]);
    expect(fake.files.size).toBe(0);
    expect(fake.discarded).toEqual(['/scratch/media.mp4']);
  });

  it('turns an adapter throw into a failed outcome instead of crashing the run', async () => {
    const fake = fakePorts({ items: [rawVideoItem()], failWriteTo: (p) => p === NOTE });
    const result = await ingestInstagram(request(reel), fake.ports);
    expect(result.ok && result.value.outcomes).toEqual([
      { kind: 'failed', shortCode: 'Db4K_XVyZOB', stage: 'write', reason: 'disk full' },
    ]);
  });

  it('warns, but keeps the saved note, when MOC upkeep fails', async () => {
    const fake = fakePorts({ items: [rawVideoItem()], failWriteTo: (p) => p.endsWith('MOC.md') });
    const result = await ingestInstagram(request(reel), fake.ports);
    expect(result.ok && result.value.outcomes[0]?.kind).toBe('saved');
    expect(result.ok && result.value.warnings).toEqual([
      'MOC not updated: disk full',
      'changelog.md not found; entry skipped',
    ]);
    expect(fake.files.has(NOTE)).toBe(true);
  });
});
