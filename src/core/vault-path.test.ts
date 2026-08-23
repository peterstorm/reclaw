import { describe, expect, it } from 'vitest';
import { parseVaultRelativePath, vaultPathBasename, withMarkdownExtension } from './vault-path.js';

describe('parseVaultRelativePath', () => {
  it.each([
    ['note', 'note'],
    ['folder/note.md', 'folder/note.md'],
    ['folder\\nested\\note', 'folder/nested/note'],
    ['  personal/My Note  ', 'personal/My Note'],
    ['.obsidian/config.json', '.obsidian/config.json'],
  ])('parses %j as %j', (raw, expected) => {
    const result = parseVaultRelativePath(raw);
    expect(result).toEqual({ ok: true, value: expected });
  });

  it.each([
    '',
    '   ',
    '/etc/passwd',
    '\\\\server\\share\\note.md',
    'C:\\Users\\person\\note.md',
    'C:relative-note.md',
    '../outside.md',
    'folder/../outside.md',
    'folder/./note.md',
    'folder//note.md',
    'folder\\..\\outside.md',
    'folder/%2e%2e/outside.md',
    'folder/%2Foutside.md',
    'folder/%5coutside.md',
    'folder/note\u0000.md',
    'folder/note\n.md',
  ])('rejects unsafe path %j', (raw) => {
    const result = parseVaultRelativePath(raw);
    expect(result.ok).toBe(false);
  });

  it('does not reject names that merely contain two dots', () => {
    expect(parseVaultRelativePath('notes/version..2.md')).toEqual({
      ok: true,
      value: 'notes/version..2.md',
    });
  });
});

describe('vault relative path helpers', () => {
  it('adds .md exactly once', () => {
    const parsed = parseVaultRelativePath('folder/note');
    if (!parsed.ok) throw new Error(parsed.error);
    expect(withMarkdownExtension(parsed.value)).toBe('folder/note.md');
    expect(withMarkdownExtension(withMarkdownExtension(parsed.value))).toBe('folder/note.md');
  });

  it('returns the basename using normalized vault separators', () => {
    const parsed = parseVaultRelativePath('folder/nested/my-note.md');
    if (!parsed.ok) throw new Error(parsed.error);
    expect(vaultPathBasename(parsed.value)).toBe('my-note.md');
  });
});
