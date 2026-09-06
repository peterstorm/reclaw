import type { Result } from './types.js';

/** Telegram Bot API download ceiling and Reclaw's per-file persistence limit. */
export const MAX_STORED_UPLOAD_BYTES = 20 * 1024 * 1024;

export type StoredUpload = {
  readonly path: string;
  readonly displayName: string;
  readonly mimeType: string | null;
  readonly sizeBytes: number;
};

const hasUnsafeInlineCharacter = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) {
      return true;
    }
  }
  return false;
};

/** Convert an untrusted Telegram filename into bounded, one-line display metadata. */
export function storedUploadDisplayName(fileName: string | undefined): string {
  const leaf = fileName?.split(/[\\/]/u).at(-1)?.trim() ?? '';
  const safe = [...leaf]
    .map((character) => (hasUnsafeInlineCharacter(character) ? '_' : character))
    .join('')
    .slice(0, 255)
    .trim();
  return safe.length > 0 ? safe : 'upload';
}

/** Preserve only a small ASCII extension; raw filenames never become filesystem paths. */
export function storedUploadExtension(displayName: string): string {
  return /\.([a-z0-9]{1,16})$/iu.exec(displayName)?.[1]?.toLowerCase() ?? 'bin';
}

/** Parse persisted upload metadata into a state safe to embed in an agent prompt. */
export function makeStoredUpload(params: StoredUpload): Result<StoredUpload, string> {
  if (params.path.trim().length === 0 || hasUnsafeInlineCharacter(params.path)) {
    return { ok: false, error: 'Upload path must be a safe non-empty line.' };
  }
  if (
    params.displayName.trim().length === 0 ||
    params.displayName.length > 255 ||
    hasUnsafeInlineCharacter(params.displayName)
  ) {
    return { ok: false, error: 'Upload display name must be a safe non-empty line.' };
  }
  if (
    params.mimeType !== null &&
    (params.mimeType.length === 0 ||
      params.mimeType.length > 255 ||
      hasUnsafeInlineCharacter(params.mimeType))
  ) {
    return { ok: false, error: 'Upload MIME type must be null or a safe non-empty line.' };
  }
  if (
    !Number.isSafeInteger(params.sizeBytes) ||
    params.sizeBytes <= 0 ||
    params.sizeBytes > MAX_STORED_UPLOAD_BYTES
  ) {
    return {
      ok: false,
      error: `Upload size must be between 1 and ${MAX_STORED_UPLOAD_BYTES} bytes.`,
    };
  }
  return { ok: true, value: Object.freeze({ ...params }) };
}
