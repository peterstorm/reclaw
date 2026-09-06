import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type StoredUpload,
  makeStoredUpload,
  storedUploadDisplayName,
  storedUploadExtension,
} from '../core/stored-upload.js';
import type { TelegramUpdateId } from '../core/types.js';

/** Durable user-owned storage. Unlike the attachment spool, these files are never auto-deleted. */
export const DEFAULT_UPLOAD_DIR = join(homedir(), '.local', 'share', 'reclaw', 'uploads');

type TelegramUploadMetadata = {
  readonly schemaVersion: 1;
  readonly source: 'telegram';
  readonly updateId: number;
  readonly originalFileName: string | null;
  readonly mimeType: string | null;
  readonly sizeBytes: number;
};

async function atomicWrite(path: string, data: Uint8Array | string): Promise<void> {
  const temporaryPath = `${path}.tmp-${crypto.randomUUID()}`;
  try {
    await writeFile(temporaryPath, data, { mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function safeMimeType(mimeType: string | undefined): string | null {
  if (mimeType === undefined) return null;
  const safe = [...mimeType.trim()]
    .filter((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined &&
        codePoint > 0x1f &&
        !(codePoint >= 0x7f && codePoint <= 0x9f) &&
        !(codePoint >= 0x202a && codePoint <= 0x202e) &&
        !(codePoint >= 0x2066 && codePoint <= 0x2069)
      );
    })
    .join('')
    .slice(0, 255);
  return safe.length > 0 ? safe : null;
}

/** Persist one authenticated Telegram upload without interpreting or executing its bytes. */
export async function persistTelegramUpload(params: {
  readonly updateId: TelegramUpdateId;
  readonly fileName: string | undefined;
  readonly mimeType: string | undefined;
  readonly data: Uint8Array;
  readonly uploadDir?: string;
}): Promise<StoredUpload> {
  const uploadDir = params.uploadDir ?? DEFAULT_UPLOAD_DIR;
  const displayName = storedUploadDisplayName(params.fileName);
  const extension = storedUploadExtension(displayName);
  const path = join(uploadDir, `telegram-${params.updateId}.${extension}`);
  const mimeType = safeMimeType(params.mimeType);
  const metadataPath = join(uploadDir, `telegram-${params.updateId}.metadata.json`);
  const metadata: TelegramUploadMetadata = {
    schemaVersion: 1,
    source: 'telegram',
    updateId: params.updateId,
    originalFileName: params.fileName ?? null,
    mimeType: params.mimeType ?? null,
    sizeBytes: params.data.byteLength,
  };
  const stored = makeStoredUpload({
    path,
    displayName,
    mimeType,
    sizeBytes: params.data.byteLength,
  });
  if (!stored.ok) throw new Error(`Invalid stored upload metadata: ${stored.error}`);

  await mkdir(uploadDir, { recursive: true, mode: 0o700 });
  await chmod(uploadDir, 0o700);
  await atomicWrite(path, params.data);
  await atomicWrite(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  return stored.value;
}
