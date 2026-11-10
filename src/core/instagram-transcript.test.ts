import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sampleTranscript } from './__fixtures__/instagram.js';
import { formatTimestamp, parseTranscript, transcriptLines } from './instagram-transcript.js';

describe('parseTranscript', () => {
  it('maps wire segments, trimming text and dropping empty ones', () => {
    const r = parseTranscript({
      language: 'da',
      segments: [
        { start: 0, text: ' Hej ' },
        { start: 2, text: '   ' },
        { start: 3.5, text: 'Verden' },
      ],
    });
    expect(r).toEqual({
      ok: true,
      value: {
        language: 'da',
        segments: [
          { startSeconds: 0, text: 'Hej' },
          { startSeconds: 3.5, text: 'Verden' },
        ],
      },
    });
  });

  it('accepts a transcript with no speech', () => {
    expect(parseTranscript({ language: 'en', segments: [] })).toEqual({
      ok: true,
      value: { language: 'en', segments: [] },
    });
  });

  it.each([
    {},
    { language: '', segments: [] },
    { language: 'en', segments: [{ start: -1, text: 'x' }] },
    null,
  ])('rejects malformed output %#', (raw) => {
    expect(parseTranscript(raw).ok).toBe(false);
  });
});

describe('formatTimestamp', () => {
  it.each([
    [0, '0:00'],
    [4.9, '0:04'],
    [65, '1:05'],
    [3725, '1:02:05'],
    [-5, '0:00'],
  ])('%s → %s', (seconds, expected) => {
    expect(formatTimestamp(seconds)).toBe(expected);
  });

  it('is monotonic in whole seconds (property)', () => {
    const asSeconds = (s: string): number =>
      s.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 400000 }), (n) => {
        expect(asSeconds(formatTimestamp(n))).toBe(n);
      }),
    );
  });
});

describe('transcriptLines', () => {
  it('renders one timestamped line per segment', () => {
    expect(transcriptLines(sampleTranscript)).toEqual([
      '[0:00] I have been coding for six years.',
      '[0:04] Here are seven habits.',
      '[1:02:05] Much later.',
    ]);
  });
});
