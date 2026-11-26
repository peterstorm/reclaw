import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { boundedLine, normalizeRef, oneLine, parseBatchOf, parseEvidence } from './submission.js';
import { err, ok } from './types.js';

describe('normalizeRef', () => {
  it('drops the fragment and utm_* parameters but keeps the rest of the query', () => {
    expect(normalizeRef('https://example.com/p?id=7&utm_source=x&UTM_Campaign=y#section')).toEqual({
      ok: true,
      value: 'https://example.com/p?id=7',
    });
  });

  it('accepts a vault note path and refuses anything else', () => {
    expect(normalizeRef('media/instagram/bashi_fuirkashi/DcRCPsHDTLH.md')).toEqual({
      ok: true,
      value: 'media/instagram/bashi_fuirkashi/DcRCPsHDTLH.md',
    });
    for (const bad of [
      'ftp://example.com/x',
      'javascript:alert(1)',
      'https://user:pw@example.com/x',
      '../secrets.md',
      '/etc/passwd.md',
      'media/instagram/x.mp4',
      '',
    ])
      expect(normalizeRef(bad).ok, bad).toBe(false);
  });

  it('refuses a ref over the length cap', () => {
    expect(normalizeRef(`https://example.com/${'a'.repeat(500)}`).ok).toBe(false);
  });

  it('is idempotent and never leaves a fragment or tracking parameter', () => {
    fc.assert(
      fc.property(fc.webUrl({ withFragments: true, withQueryParameters: true }), (url) => {
        const once = normalizeRef(`${url}${url.includes('?') ? '&' : '?'}utm_medium=feed`);
        if (!once.ok) return; // over the length cap
        expect(normalizeRef(once.value)).toEqual(once);
        expect(once.value).not.toContain('#');
        expect(once.value.toLowerCase()).not.toContain('utm_');
      }),
    );
  });
});

describe('oneLine and boundedLine', () => {
  it('oneLine collapses whitespace and refuses what it cannot keep', () => {
    expect(oneLine('f', '  a\n\n b\t c ', 20)).toEqual(ok('a b c'));
    expect(oneLine('f', '   ', 20)).toEqual(err('f is empty'));
    expect(oneLine('f', 'x'.repeat(21), 20).ok).toBe(false);
    expect(oneLine('f', 'fine\u0000then not', 20).ok).toBe(false);
  });

  it('boundedLine always yields a line the log can hold, never refusing (property)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 800 }), fc.integer({ min: 2, max: 300 }), (raw, max) => {
        const line = boundedLine(raw, max);
        expect(line.length).toBeLessThanOrEqual(max);
        expect([...line].every((ch) => ch.charCodeAt(0) > 31 && ch.charCodeAt(0) !== 127)).toBe(
          true,
        );
        expect(line).toBe(line.trim());
        // Where the strict rule accepts the text, the lenient one keeps it exactly: it only ever
        // changes what `oneLine` would have refused.
        const strict = oneLine('f', raw, max);
        if (strict.ok) expect(line).toBe(strict.value);
      }),
    );
  });

  it('boundedLine cuts an overlong line with an ellipsis', () => {
    const line = boundedLine('word '.repeat(200), 40);
    expect(line.length).toBeLessThanOrEqual(40);
    expect(line.endsWith('…')).toBe(true);
    expect(boundedLine('a\u0000b', 10)).toBe('a b');
  });
});

describe('parseEvidence', () => {
  const raw = {
    ref: 'https://example.com/x?utm_source=rss#frag',
    source: ' Eugene  Yan ',
    title: 'A title',
    takeaway: 'Says a thing.',
  };

  it('normalises every field', () => {
    expect(parseEvidence(raw)).toEqual({
      ok: true,
      value: {
        ref: 'https://example.com/x',
        source: 'Eugene Yan',
        title: 'A title',
        takeaway: 'Says a thing.',
      },
    });
  });

  it('names the first field that fails, in the order ref, source, title, takeaway', () => {
    const reason = (over: Partial<typeof raw>) => {
      const r = parseEvidence({ ...raw, ...over });
      return r.ok ? 'ok' : r.error;
    };
    expect(reason({ ref: 'ftp://x', source: '' })).toContain('ref');
    expect(reason({ source: '' })).toBe('source is empty');
    expect(reason({ title: 'x'.repeat(201) })).toContain('title');
    expect(reason({ takeaway: '' })).toBe('takeaway is empty');
  });
});

describe('parseBatchOf', () => {
  const spec = {
    noun: 'number batch',
    shape: '{n}',
    maxItems: 3,
    schema: z.object({ n: z.number() }),
    build: (item: { n: number }) => (item.n >= 0 ? ok([item.n]) : err('negative')),
  };

  it('keeps the good items and rejects the bad ones by index', () => {
    expect(parseBatchOf(JSON.stringify([{ n: 1 }, { n: -1 }, { x: 1 }]), spec)).toEqual({
      ok: true,
      value: {
        events: [1],
        rejected: [
          { index: 1, reason: 'negative' },
          { index: 2, reason: 'expected {n} (n)' },
        ],
      },
    });
  });

  it('refuses a submission that is not a bounded JSON array, naming what it is', () => {
    for (const bad of ['', 'x', '{}', '[]', '[1,2,3,4]'])
      expect(parseBatchOf(bad, spec)).toMatchObject({
        ok: false,
        error: expect.stringContaining('number batch'),
      });
  });
});
