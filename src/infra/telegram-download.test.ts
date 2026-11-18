import { afterEach, describe, expect, it, vi } from 'vitest';
import { type TelegramFileSource, downloadPhoto } from './telegram-download.js';

// downloadPhoto is fetch-only: a fake file source and a stubbed fetch cover it
// without touching the filesystem.

function fakeSource(filePath: string | undefined): TelegramFileSource {
  const getFile = vi.fn().mockResolvedValue(filePath === undefined ? {} : { file_path: filePath });
  return { api: { getFile } as unknown as TelegramFileSource['api'], token: 'secret-token' };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('downloadPhoto', () => {
  it("returns the photo's bytes and the extension from Telegram's file path", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));

    const photo = await downloadPhoto(fakeSource('photos/file_7.PNG'), 'file-id');

    expect(photo).toEqual({ data: new Uint8Array([1, 2, 3]), extension: 'png' });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.telegram.org/file/botsecret-token/photos/file_7.PNG',
    );
  });

  it.each([
    { label: 'no extension', filePath: 'photos/file_7' },
    { label: 'an over-long extension', filePath: 'photos/file_7.jpegxl' },
    { label: 'a non-alphanumeric extension', filePath: 'photos/file_7.p-g' },
  ])('falls back to jpg for $label', async ({ filePath }) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(new Uint8Array([1])));

    const photo = await downloadPhoto(fakeSource(filePath), 'file-id');

    expect(photo.extension).toBe('jpg');
  });

  it('rejects a failed HTTP download', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('gone', { status: 404 }));

    await expect(downloadPhoto(fakeSource('photos/a.jpg'), 'file-id')).rejects.toThrow(
      'Photo download failed: 404',
    );
  });

  it('rejects when Telegram returns no file path', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(downloadPhoto(fakeSource(undefined), 'file-id')).rejects.toThrow(
      'Telegram getFile returned no file_path',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
