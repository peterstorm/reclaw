import { describe, expect, it } from 'vitest';
import { markdownToTelegramHtml } from './markdown-to-telegram.js';

describe('markdownToTelegramHtml', () => {
  it('escapes HTML entities in plain text', () => {
    expect(markdownToTelegramHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });

  it('converts bold', () => {
    expect(markdownToTelegramHtml('hello **world**')).toBe('hello <b>world</b>');
  });

  it('converts italic with asterisks', () => {
    expect(markdownToTelegramHtml('hello *world*')).toBe('hello <i>world</i>');
  });

  it('converts italic with underscores', () => {
    expect(markdownToTelegramHtml('hello _world_ here')).toBe('hello <i>world</i> here');
  });

  it('converts strikethrough', () => {
    expect(markdownToTelegramHtml('hello ~~world~~')).toBe('hello <s>world</s>');
  });

  it('converts inline code', () => {
    expect(markdownToTelegramHtml('run `npm install` now')).toBe('run <code>npm install</code> now');
  });

  it('escapes HTML inside inline code', () => {
    expect(markdownToTelegramHtml('use `<div>`')).toBe('use <code>&lt;div&gt;</code>');
  });

  it('converts fenced code blocks', () => {
    const input = '```ts\nconst x = 1;\n```';
    expect(markdownToTelegramHtml(input)).toBe(
      '<pre><code class="language-ts">const x = 1;\n</code></pre>',
    );
  });

  it('converts fenced code blocks without language', () => {
    const input = '```\nhello\n```';
    expect(markdownToTelegramHtml(input)).toBe('<pre>hello\n</pre>');
  });

  it('escapes HTML inside code blocks', () => {
    const input = '```\n<b>not bold</b>\n```';
    expect(markdownToTelegramHtml(input)).toBe('<pre>&lt;b&gt;not bold&lt;/b&gt;\n</pre>');
  });

  it('does not format inside code blocks', () => {
    const input = '```\n**not bold** *not italic*\n```';
    expect(markdownToTelegramHtml(input)).toBe('<pre>**not bold** *not italic*\n</pre>');
  });

  it('converts links', () => {
    expect(markdownToTelegramHtml('[click](https://example.com)')).toBe(
      '<a href="https://example.com">click</a>',
    );
  });

  it('converts headers to bold', () => {
    expect(markdownToTelegramHtml('# Title')).toBe('<b>Title</b>');
    expect(markdownToTelegramHtml('## Subtitle')).toBe('<b>Subtitle</b>');
    expect(markdownToTelegramHtml('### Deep')).toBe('<b>Deep</b>');
  });

  it('handles mixed content', () => {
    const input = '# Hello\n\nThis is **bold** and *italic*.\n\n```ts\nconst x = 1;\n```\n\nDone.';
    const result = markdownToTelegramHtml(input);
    expect(result).toContain('<b>Hello</b>');
    expect(result).toContain('<b>bold</b>');
    expect(result).toContain('<i>italic</i>');
    expect(result).toContain('<pre><code class="language-ts">const x = 1;\n</code></pre>');
    expect(result).toContain('Done.');
  });

  it('returns empty string for empty input', () => {
    expect(markdownToTelegramHtml('')).toBe('');
  });

  it('handles text with no markdown', () => {
    expect(markdownToTelegramHtml('just plain text')).toBe('just plain text');
  });
});
