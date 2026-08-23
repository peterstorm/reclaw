import type { Result } from './types.js';

/** A normalized, non-absolute path whose segments cannot traverse upward. */
export type VaultRelativePath = string & { readonly __brand: 'VaultRelativePath' };

/** An absolute file path produced only after canonical vault containment checks. */
export type VaultFilePath = string & { readonly __brand: 'VaultFilePath' };

const WINDOWS_DRIVE_PATH = /^[a-zA-Z]:/;
const ENCODED_TRAVERSAL_TOKEN = /%(?:2e|2f|5c)/i;

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

/**
 * Parse a user- or data-provided path into the only relative-path form accepted
 * by vault adapters. Backslashes are treated as separators so Windows-style
 * traversal cannot become a literal Linux filename by accident.
 */
export function parseVaultRelativePath(raw: string): Result<VaultRelativePath, string> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, error: 'Vault path must not be empty.' };
  if (hasControlCharacter(trimmed)) {
    return { ok: false, error: 'Vault path must not contain control characters.' };
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('\\\\') || WINDOWS_DRIVE_PATH.test(trimmed)) {
    return { ok: false, error: 'Vault path must be relative to the vault root.' };
  }
  if (ENCODED_TRAVERSAL_TOKEN.test(trimmed)) {
    return {
      ok: false,
      error: 'Vault path must not contain encoded traversal or separator tokens.',
    };
  }

  const normalizedSeparators = trimmed.replaceAll('\\', '/');
  const segments = normalizedSeparators.split('/');
  if (segments.some((segment) => segment.length === 0)) {
    return { ok: false, error: 'Vault path must not contain empty segments.' };
  }
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return { ok: false, error: 'Vault path must not contain "." or ".." segments.' };
  }

  return { ok: true, value: segments.join('/') as VaultRelativePath };
}

/** Append Obsidian's Markdown extension without weakening the parsed invariant. */
export function withMarkdownExtension(path: VaultRelativePath): VaultRelativePath {
  return (path.toLowerCase().endsWith('.md') ? path : `${path}.md`) as VaultRelativePath;
}

/** Return the final path segment without exposing platform-dependent semantics. */
export function vaultPathBasename(path: VaultRelativePath): string {
  const segments = path.split('/');
  return segments[segments.length - 1] ?? '';
}
