import { join } from 'node:path';
import type { Api } from 'grammy';
import type { TelegramUpdateId } from '../core/types.js';
import { writeSpooledFile } from './telegram-spool.js';

/** Where Telegram files are fetched from: the Bot API plus the token that authorises the file URL. */
export type TelegramFileSource = {
  readonly api: Pick<Api, 'getFile'>;
  readonly token: string;
};

/** The byte ceiling of one document download, and the name its failure messages use. */
export type DownloadLimit = {
  readonly maxBytes: number;
  readonly label: string;
};

export type DownloadedBody =
  | { readonly kind: 'complete'; readonly data: Uint8Array }
  | { readonly kind: 'too-large' };

const DOCUMENT_DOWNLOAD_TIMEOUT_MS = 20_000;

type ResolvedFile = { readonly url: string; readonly filePath: string };

async function resolveFile(source: TelegramFileSource, fileId: string): Promise<ResolvedFile> {
  const file = await source.api.getFile(fileId);
  if (!file.file_path) throw new Error('Telegram getFile returned no file_path');
  return {
    url: `https://api.telegram.org/file/bot${source.token}/${file.file_path}`,
    filePath: file.file_path,
  };
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<DownloadedBody> {
  if (response.body === null) {
    const data = new Uint8Array(await response.arrayBuffer());
    return data.byteLength <= maxBytes ? { kind: 'complete', data } : { kind: 'too-large' };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    totalBytes += next.value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel('Document exceeds configured byte limit');
      return { kind: 'too-large' };
    }
    chunks.push(next.value);
  }

  const data = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: 'complete', data };
}

/** Keep a short alphanumeric extension from Telegram's file path; anything else is a JPEG. */
function photoExtension(telegramFilePath: string): string {
  const candidate = telegramFilePath.split('.').pop()?.toLowerCase() ?? '';
  return /^[a-z0-9]{1,5}$/.test(candidate) ? candidate : 'jpg';
}

/** Download one photo into the attachment spool, named after its update; returns the spool path. */
export async function downloadPhoto(
  source: TelegramFileSource,
  fileId: string,
  updateId: TelegramUpdateId,
  attachmentDir: string,
): Promise<string> {
  const file = await resolveFile(source, fileId);
  const response = await fetch(file.url);
  if (!response.ok) {
    throw new Error(`Photo download failed: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const filePath = join(attachmentDir, `${updateId}.${photoExtension(file.filePath)}`);
  await writeSpooledFile(attachmentDir, filePath, buffer);
  return filePath;
}

/** Download one document into memory, refusing (without reading further) past `limit.maxBytes`. */
export async function downloadDocument(
  source: TelegramFileSource,
  fileId: string,
  limit: DownloadLimit,
): Promise<DownloadedBody> {
  const file = await resolveFile(source, fileId);
  const response = await fetch(file.url, {
    signal: AbortSignal.timeout(DOCUMENT_DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${limit.label} download failed: ${response.status}`);

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > limit.maxBytes) {
    return { kind: 'too-large' };
  }
  return readBoundedBody(response, limit.maxBytes);
}
