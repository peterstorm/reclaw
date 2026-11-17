// Integration test: the real adapter against real ffmpeg + tesseract from nix. Fixtures are
// rendered by ffmpeg's drawtext, so the test needs nothing checked in. Skipped where nix is
// not available.

import { execFile, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ImageReading, readableLines } from '../core/instagram-screen-text.js';
import { createTesseractTextReader } from './tesseract-text-reader.js';

const run = promisify(execFile);

const hasNix = (() => {
  try {
    execFileSync('nix-shell', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const NIX_TIMEOUT_MS = 180_000;

/** Render `vf` over a solid background with ffmpeg from nix. */
const render = (output: string, seconds: number, vf: string, frames: string[]) =>
  run(
    'nix-shell',
    [
      '-p',
      'ffmpeg-headless',
      '--run',
      [
        'ffmpeg -nostdin -v error -y -f lavfi',
        `-i color=c=0x3050a0:s=720x1280:d=${seconds}:r=10`,
        `-vf "${vf}"`,
        ...frames,
        output,
      ].join(' '),
    ],
    { timeout: NIX_TIMEOUT_MS },
  );

const title = (text: string, y: number, enable = '') =>
  `drawtext=text='${text}':fontcolor=white:fontsize=72:x=(w-tw)/2:y=${y}${enable}`;

const texts = (reading: ImageReading | undefined): readonly string[] =>
  reading === undefined ? [] : readableLines(reading).map((l) => l.text.toUpperCase());

describe.skipIf(!hasNix)('createTesseractTextReader (real ffmpeg + tesseract)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'ig-ocrtest-'));
    await Promise.all([
      render(
        join(dir, 'clip.mp4'),
        4,
        [
          title('FIRST TITLE', 300, `:enable='lt(t,2)'`),
          title('SECOND TITLE', 700, `:enable='gte(t,2)'`),
        ].join(','),
        ['-pix_fmt yuv420p'],
      ),
      render(join(dir, 'one.png'), 1, title('HELLO WORLD', 400), ['-frames:v 1']),
      render(join(dir, 'two.png'), 1, 'null', ['-frames:v 1']),
    ]);
  }, NIX_TIMEOUT_MS);
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const reader = createTesseractTextReader();

  it(
    'reads each sampled frame, stamped with its time',
    async () => {
      const result = await reader.video(
        join(dir, 'clip.mp4'),
        { everySeconds: 1, maxFrames: 120 },
        ['eng'],
      );
      if (!result.ok) throw new Error(result.error);

      expect(result.value.map((f) => f.atSeconds)).toEqual([0, 1, 2, 3]);
      expect(texts(result.value[0]?.reading)).toContain('FIRST TITLE');
      expect(texts(result.value[3]?.reading)).toContain('SECOND TITLE');
      expect(texts(result.value[3]?.reading)).not.toContain('FIRST TITLE');
    },
    NIX_TIMEOUT_MS,
  );

  it(
    'stops at the frame cap',
    async () => {
      const result = await reader.video(join(dir, 'clip.mp4'), { everySeconds: 1, maxFrames: 2 }, [
        'eng',
      ]);
      if (!result.ok) throw new Error(result.error);

      expect(result.value.map((f) => f.atSeconds)).toEqual([0, 1]);
    },
    NIX_TIMEOUT_MS,
  );

  it(
    'reads images in order, an image without text reading as nothing',
    async () => {
      const result = await reader.images([join(dir, 'one.png'), join(dir, 'two.png')], ['eng']);
      if (!result.ok) throw new Error(result.error);

      expect(result.value).toHaveLength(2);
      expect(texts(result.value[0])).toEqual(['HELLO WORLD']);
      expect(texts(result.value[1])).toEqual([]);
    },
    NIX_TIMEOUT_MS,
  );

  it(
    'turns an unreadable input into an error, not a throw, and leaves no scratch behind',
    async () => {
      const before = (await fs.readdir(tmpdir())).filter((f) => f.startsWith('ig-ocr-')).length;
      const bogus = join(dir, 'not-a-video.mp4');
      await fs.writeFile(bogus, 'not a video');

      const result = await reader.video(bogus, { everySeconds: 1, maxFrames: 120 }, ['eng']);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/^Reading text failed: /);
      const after = (await fs.readdir(tmpdir())).filter((f) => f.startsWith('ig-ocr-')).length;
      expect(after).toBeLessThanOrEqual(before);
    },
    NIX_TIMEOUT_MS,
  );
});
