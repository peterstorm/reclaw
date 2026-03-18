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

  // ── --link flag ─────────────────────────────────────────────────────────────

  it('accepts --link with URL and derives topic from path', () => {
    const r = parseResearchCommand('/research --link https://example.com/article-about-ai-agents');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.topic).toBe('article about ai agents');
      expect(r.value.sourceHints).toEqual(['https://example.com/article-about-ai-agents']);
    }
  });

  it('uses explicit topic over URL-derived topic when both provided', () => {
    const r = parseResearchCommand('/research My custom topic --link https://example.com/some-path');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.topic).toBe('My custom topic');
      expect(r.value.sourceHints).toEqual(['https://example.com/some-path']);
    }
  });

  it('combines --link URL with additional source hint URLs', () => {
    const r = parseResearchCommand(
      '/research AI safety --link https://primary.com/article https://extra.com/ref',
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.topic).toBe('AI safety');
      // --link URL comes first, then additional URLs
      expect(r.value.sourceHints).toEqual([
        'https://primary.com/article',
        'https://extra.com/ref',
      ]);
    }
  });

  it('handles --link with --audio and --video flags', () => {
    const r = parseResearchCommand('/research --link https://blog.com/post --audio --video');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.topic).toBe('post');
      expect(r.value.sourceHints).toEqual(['https://blog.com/post']);
      expect(r.value.generateAudio).toBe(true);
      expect(r.value.generateVideo).toBe(true);
    }
  });

  it('derives topic from URL hostname when path is empty', () => {
    const r = parseResearchCommand('/research --link https://www.example.com');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.topic).toBe('example');
      expect(r.value.sourceHints).toEqual(['https://www.example.com']);
    }
  });

  it('handles --link with complex URL path segments', () => {
    const r = parseResearchCommand('/research --link https://arxiv.org/abs/2301.12345');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.topic).toBe('abs 2301.12345');
      expect(r.value.sourceHints).toEqual(['https://arxiv.org/abs/2301.12345']);
    }
  });

  it('handles Telegram autocorrected em dash before link', () => {
    const r = parseResearchCommand('/research —link https://example.com/article');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.sourceHints).toEqual(['https://example.com/article']);
    }
  });

  // ── Pipe separator (title | prompt) ──────────────────────────────────────

  it('splits title and prompt on pipe separator', () => {
    const r = parseResearchCommand('/research Transformer Attention | Find papers on multi-head attention after 2023');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.topic).toBe('Transformer Attention');
      expect(r.value.prompt).toBe('Find papers on multi-head attention after 2023');
      expect(r.value.sourceHints).toEqual([]);
    }
  });

  it('sets prompt to null when no pipe separator', () => {
    const r = parseResearchCommand('/research AI agents');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.prompt).toBeNull();
    }
  });

  it('collects URLs from both sides of the pipe', () => {
    const r = parseResearchCommand('/research Rust Ownership https://doc.rust-lang.org | Focus on borrow checker edge cases https://blog.rust-lang.org');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.topic).toBe('Rust Ownership');
      expect(r.value.prompt).toBe('Focus on borrow checker edge cases');
      expect(r.value.sourceHints).toEqual([
        'https://doc.rust-lang.org',
        'https://blog.rust-lang.org',
      ]);
    }
  });

  it('handles pipe with --audio flag', () => {
    const r = parseResearchCommand('/research Transformers | Focus on efficiency --audio');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.topic).toBe('Transformers');
      expect(r.value.prompt).toBe('Focus on efficiency');
      expect(r.value.generateAudio).toBe(true);
    }
  });

  it('handles pipe with --video and --audio flags', () => {
    const r = parseResearchCommand('/research AI Safety | Academic papers only --audio --video');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.topic).toBe('AI Safety');
      expect(r.value.prompt).toBe('Academic papers only');
      expect(r.value.generateAudio).toBe(true);
      expect(r.value.generateVideo).toBe(true);
    }
  });

  it('trims whitespace around pipe separator', () => {
    const r = parseResearchCommand('/research  AI Agents  |  Focus on autonomous reasoning  ');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.topic).toBe('AI Agents');
      expect(r.value.prompt).toBe('Focus on autonomous reasoning');
    }
  });

  it('sets prompt to null when pipe has empty right side', () => {
    const r = parseResearchCommand('/research AI Agents |');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.topic).toBe('AI Agents');
      expect(r.value.prompt).toBeNull();
    }
  });

  it('rejects pipe with empty left side (no title)', () => {
    const r = parseResearchCommand('/research | some prompt');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('empty');
    }
  });

  it('handles pipe with --link flag', () => {
    const r = parseResearchCommand('/research AI Safety | Focus on alignment --link https://example.com/alignment');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.topic).toBe('AI Safety');
      expect(r.value.prompt).toBe('Focus on alignment');
      expect(r.value.sourceHints).toContain('https://example.com/alignment');
    }
  });
});
