import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ocrLine, reading } from './__fixtures__/instagram.js';
import {
  type FrameReading,
  MAX_FRAMES,
  collateImageText,
  collateVideoText,
  isFragmentPair,
  isSamePlace,
  isSameText,
  normalizeOcrText,
  ocrLanguagesFor,
  parseTesseractTsv,
  planFrameSampling,
  readableLines,
  textSimilarity,
  tidyOcrText,
} from './instagram-screen-text.js';
import type { Transcript } from './instagram-transcript.js';

const HEADER =
  'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
const word = (page: number, line: number, n: number, conf: number, text: string, left = n * 100) =>
  `5\t${page}\t1\t1\t${line}\t${n}\t${left}\t200\t90\t40\t${conf}\t${text}`;
const structure = (page: number) => `1\t${page}\t0\t0\t0\t0\t0\t0\t720\t1280\t-1\t`;

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

const frames = (...perFrame: readonly (readonly ReturnType<typeof ocrLine>[])[]): FrameReading[] =>
  perFrame.map((lines, i) => ({ atSeconds: i, reading: reading(...lines) }));

describe('planFrameSampling', () => {
  it('samples every second up to the frame cap', () => {
    expect(planFrameSampling(62)).toEqual({ everySeconds: 1, maxFrames: MAX_FRAMES });
    expect(planFrameSampling(null)).toEqual({ everySeconds: 1, maxFrames: MAX_FRAMES });
  });

  it('never needs more than the cap to cover a video (property)', () => {
    fc.assert(
      fc.property(fc.double({ min: 0.1, max: 6 * 3600, noNaN: true }), (duration) => {
        const { everySeconds, maxFrames } = planFrameSampling(duration);
        expect(everySeconds).toBeGreaterThanOrEqual(1);
        expect(Number.isInteger(everySeconds)).toBe(true);
        expect(Math.ceil(duration / everySeconds)).toBeLessThanOrEqual(maxFrames);
      }),
    );
  });
});

describe('ocrLanguagesFor', () => {
  it('adds Danish only for Danish speech', () => {
    expect(ocrLanguagesFor('da')).toEqual(['dan', 'eng']);
    expect(ocrLanguagesFor('en')).toEqual(['eng']);
    expect(ocrLanguagesFor('und')).toEqual(['eng']);
    expect(ocrLanguagesFor(null)).toEqual(['eng']);
  });
});

describe('parseTesseractTsv', () => {
  it('groups confident words into lines per page with a bounding box', () => {
    const tsv = [
      HEADER,
      structure(1),
      word(1, 1, 1, 95, 'The'),
      word(1, 1, 2, 91, 'right'),
      word(1, 1, 3, 30, '~~'),
      word(1, 2, 1, 88, 'learn'),
      structure(2),
    ].join('\n');
    const pages = unwrap(parseTesseractTsv(tsv, 2));
    expect(pages).toHaveLength(2);
    expect(pages[0]).toEqual([
      { text: 'The right', confidence: 93, box: { left: 100, top: 200, width: 190, height: 40 } },
      { text: 'learn', confidence: 88, box: { left: 100, top: 200, width: 90, height: 40 } },
    ]);
    expect(pages[1]).toEqual([]);
  });

  it('drops lone low-confidence edge characters but keeps confident numbers', () => {
    const tsv = [
      HEADER,
      word(1, 1, 1, 70, '4'),
      word(1, 1, 2, 95, 'Claude'),
      word(1, 1, 3, 95, 'Code'),
      word(1, 1, 4, 80, 'o'),
      word(1, 2, 1, 96, 'Top'),
      word(1, 2, 2, 96, '3'),
    ].join('\n');
    const [lines] = unwrap(parseTesseractTsv(tsv, 1));
    expect(lines?.map((l) => l.text)).toEqual(['Claude Code', 'Top 3']);
  });

  it.each([
    ['', /header/],
    ['nonsense', /header/],
    [`${HEADER}\n5\t1\t1`, /cells/],
    [`${HEADER}\n${word(3, 1, 1, 90, 'x')}`, /page 3 of 1/],
  ])('rejects malformed output %#', (tsv, message) => {
    const r = parseTesseractTsv(tsv, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(message);
  });
});

describe('text comparison', () => {
  it('normalises to lower-case letters and digits (idempotent property)', () => {
    expect(normalizeOcrText("Claude.md File's")).toBe('claudemdfiles');
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(normalizeOcrText(normalizeOcrText(s))).toBe(normalizeOcrText(s));
      }),
    );
  });

  it('similarity is symmetric, bounded and 1 for equal texts (property)', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        const s = textSimilarity(a, b);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(1);
        expect(textSimilarity(b, a)).toBe(s);
        expect(textSimilarity(a, a)).toBe(1);
      }),
    );
  });

  it('same-text and fragment relations are symmetric (property)', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(isSameText(a, b)).toBe(isSameText(b, a));
        expect(isFragmentPair(a, b)).toBe(isFragmentPair(b, a));
      }),
    );
  });

  it('treats OCR jitter as the same text and word-by-word reveals as fragments', () => {
    expect(isSameText('Claude Code', 'CIaude Code')).toBe(true);
    expect(isSameText('Claude Code', 'RULES THAT CLAUDE CODE')).toBe(false);
    expect(isFragmentPair('right to', 'The right order to')).toBe(true);
    expect(isFragmentPair('JUST SHARED', 'AND HE JUST SHARED HIS')).toBe(true);
    expect(isFragmentPair('thatiwilllget you an', 'thatlwilliget you an interview')).toBe(true);
    expect(isFragmentPair('the', 'the right order')).toBe(false);
  });

  it('places overlapping lines in the same spot', () => {
    const box = { left: 0, top: 100, width: 300, height: 40 };
    expect(isSamePlace(box, { ...box, top: 110 })).toBe(true);
    expect(isSamePlace(box, { ...box, top: 400 })).toBe(false);
    expect(isSamePlace(box, { ...box, left: 500 })).toBe(false);
  });
});

describe('tidyOcrText', () => {
  it('trims border punctuation and collapses whitespace', () => {
    expect(tidyOcrText('| Claude   Code |')).toBe('Claude Code');
    expect(tidyOcrText('"Quoted" text!')).toBe('"Quoted" text!');
    expect(tidyOcrText('#1 rule')).toBe('#1 rule');
  });

  it('is idempotent (property)', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(tidyOcrText(tidyOcrText(s))).toBe(tidyOcrText(s));
      }),
    );
  });
});

describe('readableLines', () => {
  it('merges variants, keeping the best reading of each text once', () => {
    const lines = readableLines({
      variants: [
        [ocrLine('right to', 100, 80), ocrLine('<\\ ="', 300)],
        [ocrLine('The right order to', 100, 92), ocrLine('learn RAG', 160)],
      ],
    });
    expect(lines.map((l) => l.text)).toEqual(['The right order to', 'learn RAG']);
  });

  it('keeps a title and a subtitle that mentions it apart when they are in different places', () => {
    const lines = readableLines(
      reading(ocrLine('Claude Code', 100), ocrLine('RULES THAT CLAUDE CODE', 900)),
    );
    expect(lines.map((l) => l.text)).toEqual(['Claude Code', 'RULES THAT CLAUDE CODE']);
  });

  it('accepts short numbers only when confidently read', () => {
    expect(readableLines(reading(ocrLine('10', 100, 95))).map((l) => l.text)).toEqual(['10']);
    expect(readableLines(reading(ocrLine('18', 100, 70)))).toEqual([]);
  });
});

describe('collateVideoText', () => {
  const speech: Transcript = {
    language: 'en',
    segments: [
      { startSeconds: 0, text: 'The creator of Claude Code just shared his file.' },
      { startSeconds: 4, text: 'Rule one is plan mode first.' },
      { startSeconds: 8, text: 'Claude Code follows these rules.' },
    ],
  };

  it('reports each distinct text once, at its first frame, in time order', () => {
    const out = collateVideoText(
      frames(
        [ocrLine('The right order to'), ocrLine('learn RAG', 160)],
        [ocrLine('The right order to'), ocrLine('Iearn RAG', 160)],
        [ocrLine('The right order to'), ocrLine('learn RAG', 160), ocrLine('Step one', 600)],
        [ocrLine('Step one', 600)],
      ),
      null,
    );
    expect(out).toEqual({
      lines: [
        { atSeconds: 0, text: 'The right order to' },
        { atSeconds: 0, text: 'learn RAG' },
        { atSeconds: 2, text: 'Step one' },
      ],
      subtitleLinesOmitted: 0,
    });
  });

  it('drops text seen in a single frame of a longer video (transitions)', () => {
    const out = collateVideoText(
      frames(
        [ocrLine('Title text')],
        [ocrLine('Title text'), ocrLine('flash frame', 500)],
        [ocrLine('Title text')],
      ),
      null,
    );
    expect(out.lines.map((l) => l.text)).toEqual(['Title text']);
  });

  it('keeps single-frame text when the video was sampled at two frames or fewer', () => {
    expect(collateVideoText(frames([ocrLine('Only frame')]), null).lines).toEqual([
      { atSeconds: 0, text: 'Only frame' },
    ]);
  });

  it('leaves out brief text that repeats the speech, but keeps a long-standing title', () => {
    const subtitleFrames = Array.from({ length: 12 }, (_, i) => {
      const subtitle =
        i < 3
          ? 'THE CREATOR OF'
          : i < 6
            ? 'RULE ONE IS PLAN'
            : i < 9
              ? 'MODE FIRST'
              : 'THESE RULES';
      return [ocrLine('Claude Code', 100), ocrLine(subtitle, 900)];
    });
    const out = collateVideoText(frames(...subtitleFrames), speech);
    expect(out.lines).toEqual([{ atSeconds: 0, text: 'Claude Code' }]);
    expect(out.subtitleLinesOmitted).toBe(4);
  });

  it('does not treat words spoken at another time as a subtitle', () => {
    const late: Transcript = {
      language: 'en',
      segments: [
        { startSeconds: 0, text: 'Unrelated intro.' },
        { startSeconds: 30, text: 'Mode first, always.' },
      ],
    };
    const out = collateVideoText(
      frames([ocrLine('MODE FIRST')], [ocrLine('MODE FIRST')], []),
      late,
    );
    expect(out.lines.map((l) => l.text)).toEqual(['MODE FIRST']);
  });

  it('output is ordered, unique per text, and drawn from the input (property)', () => {
    const texts = ['Claude Code', 'learn RAG', 'Ten projects', 'Step one', 'Hire me now'];
    const frameArb = fc.array(fc.subarray(texts), { minLength: 0, maxLength: 12 });
    fc.assert(
      fc.property(frameArb, (perFrame) => {
        const input = frames(...perFrame.map((ts) => ts.map((t, i) => ocrLine(t, 100 + i * 120))));
        const { lines } = collateVideoText(input, null);
        const times = lines.map((l) => l.atSeconds);
        expect(times).toEqual([...times].sort((a, b) => a - b));
        expect(new Set(lines.map((l) => l.text)).size).toBe(lines.length);
        for (const l of lines) expect(texts).toContain(l.text);
      }),
    );
  });
});

describe('collateImageText', () => {
  it('numbers images in post order and leaves out images without text', () => {
    const out = collateImageText([
      reading(ocrLine('Why upgrade into AI engineering?')),
      reading(),
      reading(ocrLine('1. High Demand'), ocrLine('2. Higher Salary', 160)),
    ]);
    expect(out).toEqual({
      images: [
        { imageNumber: 1, lines: ['Why upgrade into AI engineering?'] },
        { imageNumber: 3, lines: ['1. High Demand', '2. Higher Salary'] },
      ],
    });
  });
});
