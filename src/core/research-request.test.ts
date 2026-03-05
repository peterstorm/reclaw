import { describe, expect, it } from 'vitest';
import { parseResearchCommand } from './research-request.js';

// ─── parseResearchCommand ─────────────────────────────────────────────────────

describe('parseResearchCommand', () => {
  // ── Basic topic extraction ────────────────────────────────────────────────

  it('extracts a simple topic with no URLs', () => {
    const r = parseResearchCommand('/research AI agents');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.topic).toBe('AI agents');
      expect(r.value.sourceHints).toEqual([]);
    }
  });

  it('trims leading/trailing whitespace from the topic', () => {
    const r = parseResearchCommand('/research   machine learning  ');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.topic).toBe('machine learning');
    }
  });

  it('handles a multi-word topic', () => {
    const r = parseResearchCommand('/research deep neural networks and transformers');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.topic).toBe('deep neural networks and transformers');
      expect(r.value.sourceHints).toEqual([]);
    }
  });

  // ── URL parsing (FR-013, FR-091) ──────────────────────────────────────────

  it('extracts topic before a single URL', () => {
    const r = parseResearchCommand('/research AI agents https://example.com');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.topic).toBe('AI agents');
      expect(r.value.sourceHints).toEqual(['https://example.com']);
    }
  });

  it('extracts topic before first URL and collects all URLs as source hints', () => {
    const r = parseResearchCommand(
      '/research machine learning https://papers.ai https://arxiv.org/abs/123',
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.topic).toBe('machine learning');
      expect(r.value.sourceHints).toEqual([
        'https://papers.ai',
        'https://arxiv.org/abs/123',
      ]);
    }
  });

  it('handles three source hint URLs', () => {
    const r = parseResearchCommand(
      '/research quantum computing https://a.com https://b.org https://c.io/path?q=1',
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.topic).toBe('quantum computing');
      expect(r.value.sourceHints).toHaveLength(3);
      expect(r.value.sourceHints[0]).toBe('https://a.com');
      expect(r.value.sourceHints[1]).toBe('https://b.org');
      expect(r.value.sourceHints[2]).toBe('https://c.io/path?q=1');
    }
  });

  it('supports http:// (non-TLS) source hints', () => {
    const r = parseResearchCommand('/research legacy systems http://old-site.com/docs');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.topic).toBe('legacy systems');
      expect(r.value.sourceHints).toEqual(['http://old-site.com/docs']);
    }
  });

  // ── Empty command validation (FR-092) ─────────────────────────────────────

  it('rejects /research with no topic (empty after prefix)', () => {
    const r = parseResearchCommand('/research');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('empty');
    }
  });

  it('rejects /research followed only by whitespace', () => {
    const r = parseResearchCommand('/research   ');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('empty');
    }
  });

  it('rejects /research with only a URL (no topic text)', () => {
    const r = parseResearchCommand('/research https://example.com');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('empty');
    }
  });

  it('rejects /research with multiple URLs but no topic text', () => {
    const r = parseResearchCommand('/research https://a.com https://b.com');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('empty');
    }
  });

  // ── Prefix detection (FR-090) ─────────────────────────────────────────────

  it('rejects messages without /research prefix', () => {
    const r = parseResearchCommand('some random message');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('/research');
    }
  });

  it('rejects /remind prefix (not /research)', () => {
    const r = parseResearchCommand('/remind tomorrow take vitamins');
    expect(r.ok).toBe(false);
  });

  it('is case-insensitive for the /research prefix', () => {
    const r = parseResearchCommand('/Research AI ethics');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.topic).toBe('AI ethics');
    }
  });

  it('is case-insensitive for /RESEARCH prefix', () => {
    const r = parseResearchCommand('/RESEARCH climate change');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.topic).toBe('climate change');
    }
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  it('handles topic with special characters', () => {
    const r = parseResearchCommand('/research C++ memory management & RAII');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.topic).toBe('C++ memory management & RAII');
      expect(r.value.sourceHints).toEqual([]);
    }
  });

  it('handles topic with numbers', () => {
    const r = parseResearchCommand('/research GPT-4 vs GPT-3.5 performance');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.topic).toBe('GPT-4 vs GPT-3.5 performance');
    }
  });

  it('handles URL with query parameters and fragments', () => {
    const r = parseResearchCommand(
      '/research rust ownership https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html#ownership-rules',
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.topic).toBe('rust ownership');
      expect(r.value.sourceHints).toEqual([
        'https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html#ownership-rules',
      ]);
    }
  });

  it('handles YouTube URL as source hint', () => {
    const r = parseResearchCommand(
      '/research transformers explained https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.topic).toBe('transformers explained');
      expect(r.value.sourceHints).toEqual([
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      ]);
    }
  });

  it('sourceHints is immutable (readonly array)', () => {
    const r = parseResearchCommand('/research topic https://a.com');
    expect(r.ok).toBe(true);
    if (r.ok) {
      // TypeScript readonly — verify it's a regular array at runtime (not mutated)
      expect(Array.isArray(r.value.sourceHints)).toBe(true);
    }
  });

  it('preserves topic text with leading/trailing whitespace stripped but internal spaces preserved', () => {
    const r = parseResearchCommand('/research  the   history  of  computing  ');
    expect(r.ok).toBe(true);
    if (r.ok) {
      // internal spaces are preserved as-is; only leading/trailing trimmed
      expect(r.value.topic).toBe('the   history  of  computing');
    }
  });
});
