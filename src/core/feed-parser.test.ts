import { describe, expect, it } from 'vitest';
import {
  decodeEntities,
  extractLink,
  firstField,
  parseFeed,
  parseNumericArg,
  selectRecentUnseen,
  sortNewestFirst,
  stripHtml,
  summarize,
  type FeedItem,
} from './feed-parser.js';

describe('decodeEntities', () => {
  it('decodes the supported named/numeric entities', () => {
    expect(decodeEntities('a &lt;b&gt; &amp; &quot;c&quot; &#39;d&#39; &apos;e&apos; f&nbsp;g')).toBe(
      `a <b> & "c" 'd' 'e' f g`,
    );
  });

  it('decodes &amp; last so &amp;lt; does not become <', () => {
    // If &amp; were decoded first, "&amp;lt;" would collapse to "&lt;" then "<".
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
  });
});

describe('stripHtml', () => {
  it('unwraps CDATA, decodes entities, then strips the revealed tags', () => {
    // Entity-encoded markup inside CDATA must end up as plain text, not visible tags.
    expect(stripHtml('<![CDATA[Hello &lt;b&gt;bold&lt;/b&gt; world]]>')).toBe('Hello bold world');
  });

  it('strips real tags and collapses whitespace', () => {
    expect(stripHtml('<p>one   two\n\tthree</p>')).toBe('one two three');
  });

  it('removes a stray CDATA closer from malformed feeds', () => {
    expect(stripHtml('text ]]> more')).toBe('text more');
  });

  it('is idempotent on already-clean text', () => {
    expect(stripHtml('plain text')).toBe('plain text');
  });
});

describe('firstField', () => {
  it('returns the first matching tag in preference order', () => {
    const block = '<summary>S</summary><description>D</description>';
    expect(firstField(block, ['description', 'summary'])).toBe('D');
    expect(firstField(block, ['content', 'summary'])).toBe('S');
  });

  it('matches tags with attributes', () => {
    expect(firstField('<title type="html">Hi</title>', ['title'])).toBe('Hi');
  });

  it('returns null when no tag matches', () => {
    expect(firstField('<title>x</title>', ['link'])).toBeNull();
  });
});

describe('extractLink', () => {
  it('prefers the Atom rel="alternate" link over other rels', () => {
    const block =
      '<link rel="self" href="https://feed.example/self"/>' +
      '<link rel="alternate" href="https://example.com/post"/>';
    expect(extractLink(block)).toBe('https://example.com/post');
  });

  it('falls back to the first Atom link when no rel="alternate" is present', () => {
    expect(extractLink('<link href="https://example.com/first"/>')).toBe(
      'https://example.com/first',
    );
  });

  it('reads an RSS <link>text</link> body', () => {
    expect(extractLink('<link>https://example.com/rss</link>')).toBe('https://example.com/rss');
  });

  it('returns null when there is no link', () => {
    expect(extractLink('<title>no link</title>')).toBeNull();
  });
});

describe('summarize', () => {
  it('clips to the first two sentences', () => {
    const block = '<description>One. Two. Three. Four.</description>';
    expect(summarize(block)).toBe('One. Two.…');
  });

  it('never exceeds the 280-char bound (+ ellipsis)', () => {
    const long = 'x'.repeat(500);
    const out = summarize(`<description>${long}</description>`);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(281);
  });

  it('returns empty string when no summary field exists', () => {
    expect(summarize('<title>t</title>')).toBe('');
  });
});

describe('parseFeed', () => {
  const rss = `
    <rss><channel>
      <item>
        <title>First &amp; Best</title>
        <link>https://example.com/a</link>
        <pubDate>Wed, 15 Jul 2026 10:00:00 GMT</pubDate>
        <description><![CDATA[<p>Body one. Body two. Body three.</p>]]></description>
      </item>
      <item>
        <title>No link here</title>
        <pubDate>Wed, 15 Jul 2026 11:00:00 GMT</pubDate>
      </item>
      <item>
        <title>Undated</title>
        <link>https://example.com/b</link>
      </item>
    </channel></rss>`;

  it('parses items, decoding title entities and normalizing dates to ISO', () => {
    const items = parseFeed('Example', rss);
    expect(items).toHaveLength(2); // the link-less item is dropped
    expect(items[0]).toMatchObject({
      source: 'Example',
      title: 'First & Best',
      link: 'https://example.com/a',
      summary: 'Body one. Body two.…',
    });
    expect(items[0]?.date).toBe(new Date('Wed, 15 Jul 2026 10:00:00 GMT').toISOString());
  });

  it('keeps items with unparseable/absent dates as date: null', () => {
    const items = parseFeed('Example', rss);
    const undated = items.find((i) => i.title === 'Undated');
    expect(undated?.date).toBeNull();
  });

  it('parses Atom <entry> blocks with rel="alternate" links', () => {
    const atom = `<feed>
      <entry>
        <title>Atom Post</title>
        <link rel="alternate" href="https://example.com/atom"/>
        <updated>2026-07-15T09:00:00Z</updated>
        <summary>Short summary.</summary>
      </entry>
    </feed>`;
    const items = parseFeed('Atomic', atom);
    expect(items).toEqual<FeedItem[]>([
      {
        source: 'Atomic',
        title: 'Atom Post',
        link: 'https://example.com/atom',
        date: '2026-07-15T09:00:00.000Z',
        summary: 'Short summary.',
      },
    ]);
  });

  it('returns an empty array for a document with no items', () => {
    expect(parseFeed('Empty', '<rss><channel></channel></rss>')).toEqual([]);
  });
});

describe('selectRecentUnseen', () => {
  const mk = (link: string, date: string | null): FeedItem => ({
    source: 's',
    title: 't',
    link,
    date,
    summary: '',
  });
  const cutoffMs = Date.parse('2026-07-10T00:00:00Z');

  it('drops items older than the cutoff but keeps undated ones', () => {
    const items = [
      mk('recent', '2026-07-12T00:00:00Z'),
      mk('old', '2026-07-01T00:00:00Z'),
      mk('undated', null),
    ];
    const out = selectRecentUnseen(items, { cutoffMs, seen: new Set(), maxPerFeed: 10 });
    expect(out.map((i) => i.link)).toEqual(['recent', 'undated']);
  });

  it('filters out seen links', () => {
    const items = [mk('a', null), mk('b', null)];
    const out = selectRecentUnseen(items, { cutoffMs, seen: new Set(['a']), maxPerFeed: 10 });
    expect(out.map((i) => i.link)).toEqual(['b']);
  });

  it('caps at maxPerFeed', () => {
    const items = [mk('a', null), mk('b', null), mk('c', null)];
    const out = selectRecentUnseen(items, { cutoffMs, seen: new Set(), maxPerFeed: 2 });
    expect(out).toHaveLength(2);
  });
});

describe('sortNewestFirst', () => {
  it('orders by date descending with undated items last, without mutating input', () => {
    const items: FeedItem[] = [
      { source: 's', title: 'mid', link: '2', date: '2026-07-10T00:00:00Z', summary: '' },
      { source: 's', title: 'undated', link: '3', date: null, summary: '' },
      { source: 's', title: 'new', link: '1', date: '2026-07-15T00:00:00Z', summary: '' },
    ];
    const sorted = sortNewestFirst(items);
    expect(sorted.map((i) => i.title)).toEqual(['new', 'mid', 'undated']);
    // input untouched
    expect(items.map((i) => i.title)).toEqual(['mid', 'undated', 'new']);
  });
});

describe('parseNumericArg', () => {
  it('returns the fallback with no warning when the arg is absent', () => {
    expect(parseNumericArg('--days', undefined, 3)).toEqual({ value: 3 });
  });

  it('parses a valid positive number', () => {
    expect(parseNumericArg('--days', '7', 3)).toEqual({ value: 7 });
  });

  it.each(['foo', 'NaN', '0', '-1', ''])(
    'falls back with a warning for invalid input %j',
    (raw) => {
      const result = parseNumericArg('--days', raw, 3);
      expect(result.value).toBe(3);
      expect(result.warning).toContain('--days');
    },
  );
});
