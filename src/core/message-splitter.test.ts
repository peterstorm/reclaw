import { describe, expect, it } from 'vitest';
import { splitMessage } from './message-splitter.js';

// ─── Core invariant helpers ───────────────────────────────────────────────────

function assertInvariants(text: string, chunks: readonly string[], maxLength: number): void {
  // No content loss
  expect(chunks.join('')).toBe(text);
  // Every chunk within limit
  for (const chunk of chunks) {
    expect(chunk.length).toBeLessThanOrEqual(maxLength);
  }
}

// ─── Basic cases ──────────────────────────────────────────────────────────────

describe('splitMessage', () => {
  it('returns empty array for empty string', () => {
    expect(splitMessage('')).toEqual([]);
  });

  it('returns single chunk when text fits within maxLength', () => {
    const text = 'Hello, world!';
    const result = splitMessage(text, 4096);
    expect(result).toEqual([text]);
  });

  it('returns single chunk when text equals maxLength exactly', () => {
    const text = 'a'.repeat(4096);
    const result = splitMessage(text, 4096);
    expect(result).toEqual([text]);
  });

  it('splits text exceeding default maxLength of 4096', () => {
    const text = 'a'.repeat(5000);
    const result = splitMessage(text);
    assertInvariants(text, result, 4096);
    expect(result.length).toBeGreaterThan(1);
  });

  it('splits at paragraph boundary (\\n\\n)', () => {
    const paragraph1 = 'a'.repeat(3000);
    const paragraph2 = 'b'.repeat(2000);
    const text = `${paragraph1}\n\n${paragraph2}`;
    const result = splitMessage(text, 4096);
    assertInvariants(text, result, 4096);
    // paragraph1 + \n\n fits in one chunk (3002 chars)
    expect(result[0]).toBe(`${paragraph1}\n\n`);
    expect(result[1]).toBe(paragraph2);
  });

  it('splits at sentence boundary', () => {
    // Build a string where a sentence ends just before the limit
    const sentence1 = 'This is sentence one. ';
    const filler = 'a'.repeat(4096 - sentence1.length - 1); // just over
    const text = `${sentence1}${filler}extra`;
    const result = splitMessage(text, 4096);
    assertInvariants(text, result, 4096);
    expect(result.length).toBeGreaterThan(1);
  });

  it('splits at word boundary when no sentence boundary', () => {
    // Word split: one long word followed by spaces and another word
    const word1 = 'a'.repeat(4000);
    const word2 = 'b'.repeat(200);
    const text = `${word1} ${word2}`;
    const result = splitMessage(text, 4096);
    assertInvariants(text, result, 4096);
    expect(result.length).toBeGreaterThan(1);
  });

  it('hard-cuts a single word longer than maxLength', () => {
    const longWord = 'x'.repeat(10);
    const result = splitMessage(longWord, 4);
    assertInvariants(longWord, result, 4);
    expect(result.length).toBeGreaterThan(1);
  });

  it('respects custom maxLength', () => {
    const text = 'Hello, world! How are you?';
    const result = splitMessage(text, 10);
    assertInvariants(text, result, 10);
  });

  it('preserves all content across splits (no content loss)', () => {
    const text = Array.from({ length: 100 }, (_, i) => `Paragraph ${i}.\n\n`).join('');
    const result = splitMessage(text, 4096);
    expect(result.join('')).toBe(text);
  });

  it('all chunks within maxLength for large text', () => {
    const text = 'Lorem ipsum dolor sit amet. '.repeat(500);
    const result = splitMessage(text, 4096);
    assertInvariants(text, result, 4096);
  });

  it('handles text with only newlines', () => {
    const text = '\n'.repeat(100);
    const result = splitMessage(text, 4096);
    assertInvariants(text, result, 4096);
  });

  it('handles single newline', () => {
    const text = '\n';
    const result = splitMessage(text, 4096);
    expect(result).toEqual(['\n']);
  });

  it('throws RangeError for maxLength < 1', () => {
    expect(() => splitMessage('hello', 0)).toThrowError(RangeError);
    expect(() => splitMessage('hello', -1)).toThrowError(RangeError);
  });

  it('handles text with multiple paragraphs each fitting individually', () => {
    const para = 'Short paragraph.\n\n';
    const text = para.repeat(10);
    const result = splitMessage(text, 4096);
    assertInvariants(text, result, 4096);
    expect(result.length).toBe(1); // all fits in one chunk
  });

  it('property: chunks.join("") === original for varied inputs', () => {
    const inputs = [
      'single chunk',
      'a'.repeat(8192),
      'Line 1.\nLine 2.\nLine 3.\n',
      'Sentence one. Sentence two! Sentence three? Continue.',
      'word '.repeat(2000),
    ];
    for (const input of inputs) {
      const result = splitMessage(input, 4096);
      expect(result.join('')).toBe(input);
      for (const chunk of result) {
        expect(chunk.length).toBeLessThanOrEqual(4096);
      }
    }
  });
});
