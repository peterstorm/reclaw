// ─── Markdown to Telegram HTML ───────────────────────────────────────────────
//
// Converts GitHub-flavored markdown (as Claude outputs) to Telegram-compatible
// HTML. Telegram supports: <b>, <i>, <s>, <code>, <pre>, <a href="">.
//
// Pure function — no I/O, no side effects.

/** Escape HTML special characters in plain text. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Convert a markdown string to Telegram-compatible HTML.
 *
 * Handles (in order of processing):
 * 1. Fenced code blocks (```lang\n...\n```)
 * 2. Inline code (`...`)
 * 3. Bold (**...**)
 * 4. Italic (*...* and _..._)
 * 5. Strikethrough (~~...~~)
 * 6. Links ([text](url))
 * 7. Headers (# ... → bold)
 * 8. Bullet lists (* and - prefixed lines)
 * 9. HTML entity escaping for remaining text
 */
export function markdownToTelegramHtml(md: string): string {
  // Split into fenced code blocks and everything else.
  // This prevents formatting inside code blocks from being converted.
  const parts: string[] = [];
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex loop
  while ((match = codeBlockRegex.exec(md)) !== null) {
    // Process text before this code block
    if (match.index > lastIndex) {
      parts.push(convertInlineMarkdown(md.slice(lastIndex, match.index)));
    }
    // Emit code block as <pre><code>
    const lang = match[1];
    const code = escapeHtml(match[2]!);
    if (lang) {
      parts.push(`<pre><code class="language-${lang}">${code}</code></pre>`);
    } else {
      parts.push(`<pre>${code}</pre>`);
    }
    lastIndex = match.index + match[0].length;
  }

  // Process remaining text after last code block
  if (lastIndex < md.length) {
    parts.push(convertInlineMarkdown(md.slice(lastIndex)));
  }

  return parts.join('');
}

/** Convert inline markdown (everything except fenced code blocks). */
function convertInlineMarkdown(text: string): string {
  // Split on inline code spans to protect them from further processing
  const segments: string[] = [];
  const inlineCodeRegex = /`([^`]+)`/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;

  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex loop
  while ((m = inlineCodeRegex.exec(text)) !== null) {
    if (m.index > lastIdx) {
      segments.push(convertFormattedText(text.slice(lastIdx, m.index)));
    }
    segments.push(`<code>${escapeHtml(m[1]!)}</code>`);
    lastIdx = m.index + m[0].length;
  }

  if (lastIdx < text.length) {
    segments.push(convertFormattedText(text.slice(lastIdx)));
  }

  return segments.join('');
}

/** Convert bold, italic, strikethrough, links, and headers in plain text. */
function convertFormattedText(text: string): string {
  let result = escapeHtml(text);

  // Headers: lines starting with # → bold (Telegram has no header element)
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // Bullet lists: lines starting with * or - followed by space → bullet character
  // Must be done BEFORE italic processing so `* item` isn't treated as italic
  result = result.replace(/^(\s*)[*\-]\s+/gm, '$1• ');

  // Bold: **text**
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

  // Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Italic: *text* — require non-whitespace after opening * and before closing *
  // Negative lookbehind for * prevents matching inside bold, and \S ensures
  // we don't match stray asterisks like bullet remnants
  result = result.replace(/(?<![*\\])(?:^|(?<=\s))\*(\S(?:[^*]*\S)?)\*(?![*])/g, '<i>$1</i>');

  // Italic: _text_ (word boundary variant)
  result = result.replace(/\b_([^_]+)_\b/g, '<i>$1</i>');

  // Links: [text](url) — HTML entities were already escaped, so match &amp; etc.
  result = result.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2">$1</a>',
  );

  return result;
}
