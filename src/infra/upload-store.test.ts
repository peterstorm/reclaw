import { stat } from 'node:fs/promises';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTelegramUpdateId } from '../core/types.js';
import { persistTelegramUpload } from './upload-store.js';

describe('persistTelegramUpload', () => {
  it('stores opaque bytes and exact original-name metadata with restrictive permissions', async () => {
    const uploadDir = await mkdtemp(join(tmpdir(), 'reclaw-uploads-'));
    const updateId = makeTelegramUpdateId(42);
    if (!updateId.ok) throw new Error(updateId.error);
    const data = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

    try {
      const stored = await persistTelegramUpload({
        updateId: updateId.value,
        fileName: '../../My bundle.skill',
        mimeType: 'application/octet-stream',
        data,
        uploadDir,
      });

      expect(stored).toEqual({
        path: join(uploadDir, 'telegram-42.skill'),
        displayName: 'My bundle.skill',
        mimeType: 'application/octet-stream',
        sizeBytes: 4,
      });
      expect(new Uint8Array(await readFile(stored.path))).toEqual(data);
      expect(
        JSON.parse(await readFile(join(uploadDir, 'telegram-42.metadata.json'), 'utf8')),
      ).toEqual({
        schemaVersion: 1,
        source: 'telegram',
        updateId: 42,
        originalFileName: '../../My bundle.skill',
        mimeType: 'application/octet-stream',
        sizeBytes: 4,
      });
      expect((await stat(uploadDir)).mode & 0o777).toBe(0o700);
      expect((await stat(stored.path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(uploadDir, { recursive: true, force: true });
    }
  });

  it('uses a generated binary path when no safe extension exists', async () => {
    const uploadDir = await mkdtemp(join(tmpdir(), 'reclaw-uploads-'));
    const updateId = makeTelegramUpdateId(43);
    if (!updateId.ok) throw new Error(updateId.error);

    try {
      const stored = await persistTelegramUpload({
        updateId: updateId.value,
        fileName: '../payload.dangerously-long-extension',
        mimeType: undefined,
        data: new Uint8Array([1]),
        uploadDir,
      });
      expect(stored.path).toBe(join(uploadDir, 'telegram-43.bin'));
      expect(stored.mimeType).toBeNull();
    } finally {
      await rm(uploadDir, { recursive: true, force: true });
    }
  });
});
