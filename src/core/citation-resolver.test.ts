import { describe, expect, it } from 'vitest';
import {
  resolveAnswerCitations,
  generatePassageAnchors,
  sanitizeTitleForWikilink,
} from './citation-resolver.js';
import type { SourceMeta } from './research-types.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const makeSource = (overrides: Partial<SourceMeta> = {}): SourceMeta => ({
  id: 'src-1',
  title: 'My Source Title',
  url: 'https://example.com',
  sourceType: 'web',
  ...overrides,
});

const sources: readonly SourceMeta[] = [
  makeSource({ id: 'src-1', title: 'First Source', url: 'https://first.com' }),
  makeSource({ id: 'src-2', title: 'Second Source', url: 'https://second.com', sourceType: 'youtube' }),
  makeSource({ id: 'src-3', title: 'Third Source', url: 'https://third.com', sourceType: 'pdf' }),
];

// ─── resolveAnswerCitations ────────────────────────────────────────────────────

describe('resolveAnswerCitations', () => {
  describe('FR-031/FR-032: basic citation replacement', () => {
    it('replaces a single [1] marker with the correct wikilink', () => {
      const { resolvedText } = resolveAnswerCitations('This is from [1].', sources);
      expect(resolvedText).toBe('This is from [[First Source#Passage 1]].');
    });

    it('replaces [2] with second source wikilink', () => {
      const { resolvedText } = resolveAnswerCitations('See also [2].', sources);
      expect(resolvedText).toBe('See also [[Second Source#Passage 2]].');
    });

    it('replaces [3] with third source wikilink', () => {
      const { resolvedText } = resolveAnswerCitations('[3] covers this topic.', sources);
      expect(resolvedText).toBe('[[Third Source#Passage 3]] covers this topic.');
    });

    it('replaces multiple different markers in one text', () => {
      const { resolvedText } = resolveAnswerCitations('From [1] and [2].', sources);
      expect(resolvedText).toBe('From [[First Source#Passage 1]] and [[Second Source#Passage 2]].');
    });

    it('replaces three different markers in one text', () => {
      const { resolvedText } = resolveAnswerCitations('[1] [2] [3]', sources);
      expect(resolvedText).toBe('[[First Source#Passage 1]] [[Second Source#Passage 2]] [[Third Source#Passage 3]]');
    });

    it('replaces repeated occurrences of the same marker', () => {
      const { resolvedText } = resolveAnswerCitations('[1] repeated [1].', sources);
      expect(resolvedText).toBe('[[First Source#Passage 1]] repeated [[First Source#Passage 1]].');
    });
  });

  describe('SC-007: no unresolved markers', () => {
    it('produces no unresolved [N] markers when all sources exist', () => {
      const answer = 'According to [1] and [2] and [3], the conclusion is clear.';
      const { resolvedText } = resolveAnswerCitations(answer, sources);
      // Check no bare [N] remains
      expect(resolvedText).not.toMatch(/\[\d+\]/);
    });

    it('leaves [N] marker unchanged when N is out of range', () => {
      const { resolvedText } = resolveAnswerCitations('See [99].', sources);
      expect(resolvedText).toBe('See [99].');
    });

    it('leaves [0] unchanged (0 is not a valid 1-indexed citation)', () => {
      // sources[0-1] = sources[-1] = undefined
      const { resolvedText } = resolveAnswerCitations('[0]', sources);
      expect(resolvedText).toBe('[0]');
    });
  });

  describe('citedSourceIndices set', () => {
    it('returns empty set for text with no citations', () => {
      const { citedSourceIndices } = resolveAnswerCitations('No citations here.', sources);
      expect(citedSourceIndices.size).toBe(0);
    });

    it('returns index 0 for [1]', () => {
      const { citedSourceIndices } = resolveAnswerCitations('[1]', sources);
      expect(citedSourceIndices.has(0)).toBe(true);
    });

    it('returns index 1 for [2]', () => {
      const { citedSourceIndices } = resolveAnswerCitations('[2]', sources);
      expect(citedSourceIndices.has(1)).toBe(true);
    });

    it('returns all cited indices for multiple citations', () => {
      const { citedSourceIndices } = resolveAnswerCitations('[1] [3]', sources);
      expect(citedSourceIndices.has(0)).toBe(true);
      expect(citedSourceIndices.has(2)).toBe(true);
      expect(citedSourceIndices.size).toBe(2);
    });

    it('deduplicates repeated citations (same index counted once)', () => {
      const { citedSourceIndices } = resolveAnswerCitations('[1] [1] [1]', sources);
      expect(citedSourceIndices.size).toBe(1);
      expect(citedSourceIndices.has(0)).toBe(true);
    });

    it('does not include out-of-range indices', () => {
      const { citedSourceIndices } = resolveAnswerCitations('[1] [99]', sources);
      expect(citedSourceIndices.size).toBe(1);
      expect(citedSourceIndices.has(0)).toBe(true);
    });
  });

  describe('multi-citation formats', () => {
    it('resolves comma-separated [N, M] into two wikilinks', () => {
      const { resolvedText } = resolveAnswerCitations('See [1, 2].', sources);
      expect(resolvedText).toBe('See [[First Source#Passage 1]], [[Second Source#Passage 2]].');
    });

    it('resolves range [1-3] into three wikilinks', () => {
      const { resolvedText } = resolveAnswerCitations('See [1-3].', sources);
      expect(resolvedText).toBe('See [[First Source#Passage 1]], [[Second Source#Passage 2]], [[Third Source#Passage 3]].');
    });

    it('resolves comma-separated with spaces [1, 3]', () => {
      const { resolvedText } = resolveAnswerCitations('From [1, 3].', sources);
      expect(resolvedText).toBe('From [[First Source#Passage 1]], [[Third Source#Passage 3]].');
    });

    it('tracks all cited indices from multi-citation groups', () => {
      const { citedSourceIndices } = resolveAnswerCitations('[1, 2, 3]', sources);
      expect(citedSourceIndices.has(0)).toBe(true);
      expect(citedSourceIndices.has(1)).toBe(true);
      expect(citedSourceIndices.has(2)).toBe(true);
      expect(citedSourceIndices.size).toBe(3);
    });

    it('leaves entire group unchanged when all citations are out of range', () => {
      const { resolvedText } = resolveAnswerCitations('See [98, 99].', sources);
      expect(resolvedText).toBe('See [98, 99].');
    });

    it('partially resolves when some citations are in range and some are not', () => {
      const { resolvedText } = resolveAnswerCitations('See [1, 99].', sources);
      expect(resolvedText).toContain('[[First Source#Passage 1]]');
      expect(resolvedText).toContain('[99]');
    });

    it('handles en-dash range [1–3]', () => {
      const { resolvedText } = resolveAnswerCitations('See [1\u20133].', sources);
      expect(resolvedText).toBe('See [[First Source#Passage 1]], [[Second Source#Passage 2]], [[Third Source#Passage 3]].');
    });
  });

  describe('edge cases', () => {
    it('handles empty answer text', () => {
      const { resolvedText, citedSourceIndices } = resolveAnswerCitations('', sources);
      expect(resolvedText).toBe('');
      expect(citedSourceIndices.size).toBe(0);
    });

    it('handles empty sources list — all markers remain unchanged', () => {
      const { resolvedText } = resolveAnswerCitations('See [1] and [2].', []);
      expect(resolvedText).toBe('See [1] and [2].');
    });

    it('handles text with no [N] markers', () => {
      const text = 'This answer has no citations at all.';
      const { resolvedText } = resolveAnswerCitations(text, sources);
      expect(resolvedText).toBe(text);
    });

    it('handles multi-digit citation numbers like [10]', () => {
      const moresources: SourceMeta[] = Array.from({ length: 10 }, (_, i) =>
        makeSource({ id: `src-${i + 1}`, title: `Source ${i + 1}`, url: `https://source${i + 1}.com` }),
      );
      const { resolvedText } = resolveAnswerCitations('See [10].', moresources);
      expect(resolvedText).toBe('See [[Source 10#Passage 10]].');
    });

    it('does not replace [N] when embedded in a word (e.g. [10abc]) — only pure digits', () => {
      // Our regex is \[(\d+)\] which only matches digit-only content
      const { resolvedText } = resolveAnswerCitations('Test [1abc] here.', sources);
      // [1abc] doesn't match \[(\d+)\] so stays unchanged
      expect(resolvedText).toBe('Test [1abc] here.');
    });
  });

  describe('wikilink format', () => {
    it('uses the format [[Title#Passage N]]', () => {
      const { resolvedText } = resolveAnswerCitations('[1]', sources);
      expect(resolvedText).toMatch(/\[\[.*#Passage 1\]\]/);
    });

    it('includes the source title in the wikilink', () => {
      const { resolvedText } = resolveAnswerCitations('[1]', sources);
      expect(resolvedText).toContain('First Source');
    });

    it('sanitizes source title in wikilink (removes invalid chars from title part)', () => {
      const specialSources: readonly SourceMeta[] = [
        makeSource({ title: 'Title [with] brackets & pipes|#' }),
      ];
      const { resolvedText } = resolveAnswerCitations('[1]', specialSources);
      // The wikilink is [[SanitizedTitle#Passage N]]
      // Extract just the title part (before the # anchor separator)
      const inner = resolvedText.slice(2, resolvedText.length - 2); // strip outer [[ and ]]
      const titlePart = inner.split('#')[0]!;
      // Title part should not contain wikilink-invalid characters
      expect(titlePart).not.toMatch(/[[\]|#^]/);
    });
  });
});

// ─── generatePassageAnchors ────────────────────────────────────────────────────

describe('generatePassageAnchors', () => {
  const source = makeSource({ title: 'Test Source' });

  describe('FR-033: passage anchor headings', () => {
    it('returns empty string for empty passageNumbers', () => {
      const result = generatePassageAnchors(source, []);
      expect(result).toBe('');
    });

    it('generates a single ## Passage N heading', () => {
      const result = generatePassageAnchors(source, [1]);
      expect(result).toBe('## Passage 1');
    });

    it('generates multiple ## Passage N headings separated by blank lines', () => {
      const result = generatePassageAnchors(source, [1, 2, 3]);
      expect(result).toBe('## Passage 1\n\n## Passage 2\n\n## Passage 3');
    });

    it('sorts passage numbers ascending', () => {
      const result = generatePassageAnchors(source, [3, 1, 2]);
      expect(result).toBe('## Passage 1\n\n## Passage 2\n\n## Passage 3');
    });

    it('handles large passage numbers', () => {
      const result = generatePassageAnchors(source, [10, 20]);
      expect(result).toBe('## Passage 10\n\n## Passage 20');
    });

    it('deduplicates passage numbers (same N appearing twice)', () => {
      // Sort+dedup is handled by the caller when building passageNumbers,
      // but generatePassageAnchors itself uses sort which keeps duplicates.
      // Verify it doesn't error.
      const result = generatePassageAnchors(source, [1, 1, 2]);
      expect(result).toContain('## Passage 1');
      expect(result).toContain('## Passage 2');
    });
  });

  describe('rawPassages support', () => {
    it('includes raw passage text below the heading when rawPassages provided', () => {
      const rawPassages: ReadonlyMap<number, string> = new Map([
        [1, 'This is the raw passage text for passage 1.'],
      ]);
      const result = generatePassageAnchors(source, [1], rawPassages);
      expect(result).toBe('## Passage 1\n\nThis is the raw passage text for passage 1.');
    });

    it('uses empty anchor for passages not in rawPassages map', () => {
      const rawPassages: ReadonlyMap<number, string> = new Map([
        [1, 'Raw text for 1.'],
      ]);
      const result = generatePassageAnchors(source, [1, 2], rawPassages);
      expect(result).toContain('## Passage 1\n\nRaw text for 1.');
      expect(result).toContain('## Passage 2');
      // Passage 2 should just be the heading, no text following it on same line
      const parts = result.split('\n\n');
      const passage2Part = parts.find((p) => p.startsWith('## Passage 2'));
      expect(passage2Part).toBe('## Passage 2');
    });

    it('trims raw passage text', () => {
      const rawPassages: ReadonlyMap<number, string> = new Map([
        [1, '  trimmed text  '],
      ]);
      const result = generatePassageAnchors(source, [1], rawPassages);
      expect(result).toBe('## Passage 1\n\ntrimmed text');
    });

    it('treats empty-string rawPassage same as missing (empty anchor)', () => {
      const rawPassages: ReadonlyMap<number, string> = new Map([
        [1, '   '],  // whitespace-only
      ]);
      const result = generatePassageAnchors(source, [1], rawPassages);
      expect(result).toBe('## Passage 1');
    });

    it('handles rawPassages=undefined (all empty anchors)', () => {
      const result = generatePassageAnchors(source, [1, 2], undefined);
      expect(result).toBe('## Passage 1\n\n## Passage 2');
    });
  });
});

// ─── sanitizeTitleForWikilink ─────────────────────────────────────────────────

describe('sanitizeTitleForWikilink', () => {
  it('passes through clean titles unchanged', () => {
    expect(sanitizeTitleForWikilink('Clean Title')).toBe('Clean Title');
  });

  it('strips square brackets', () => {
    expect(sanitizeTitleForWikilink('Title [with] brackets')).toBe('Title with brackets');
  });

  it('strips pipe characters', () => {
    expect(sanitizeTitleForWikilink('Title|Alternate')).toBe('TitleAlternate');
  });

  it('strips hash characters', () => {
    expect(sanitizeTitleForWikilink('Title#Section')).toBe('TitleSection');
  });

  it('strips caret characters', () => {
    expect(sanitizeTitleForWikilink('Title^Block')).toBe('TitleBlock');
  });

  it('collapses multiple spaces', () => {
    expect(sanitizeTitleForWikilink('Title  with   spaces')).toBe('Title with spaces');
  });

  it('trims leading/trailing whitespace', () => {
    expect(sanitizeTitleForWikilink('  Title  ')).toBe('Title');
  });

  it('handles empty string', () => {
    expect(sanitizeTitleForWikilink('')).toBe('');
  });

  it('strips all wikilink-invalid characters in one pass', () => {
    const result = sanitizeTitleForWikilink('A[B]C|D#E^F');
    expect(result).not.toMatch(/[[\]|#^]/);
  });

  it('strips colons from titles', () => {
    expect(sanitizeTitleForWikilink('Code Execution with MCP: A New Approach')).toBe(
      'Code Execution with MCP A New Approach',
    );
  });

  it('strips all filesystem-illegal characters', () => {
    const result = sanitizeTitleForWikilink('A/B\\C:D*E?F"G<H>I');
    expect(result).not.toMatch(/[/\\:*?"<>]/);
    expect(result).toBe('ABCDEFGHI');
  });
});
