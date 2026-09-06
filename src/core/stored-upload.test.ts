import { describe, expect, it } from 'vitest';
import {
  MAX_STORED_UPLOAD_BYTES,
  makeStoredUpload,
  storedUploadDisplayName,
  storedUploadExtension,
} from './stored-upload.js';

describe('stored upload metadata', () => {
  it('removes path components and unsafe controls from display names', () => {
    expect(storedUploadDisplayName('../../folder/bundle\n.skill')).toBe('bundle_.skill');
    expect(storedUploadDisplayName('..\\folder\\bundle.skill')).toBe('bundle.skill');
  });

  it('preserves only bounded ASCII extensions for physical storage', () => {
    expect(storedUploadExtension('bundle.skill')).toBe('skill');
    expect(storedUploadExtension('archive.tar.gz')).toBe('gz');
    expect(storedUploadExtension('payload.very-long-untrusted-extension')).toBe('bin');
    expect(storedUploadExtension('no-extension')).toBe('bin');
  });

  it('accepts safe prompt metadata within the upload size limit', () => {
    expect(
      makeStoredUpload({
        path: '/data/telegram-42.skill',
        displayName: 'bundle.skill',
        mimeType: 'application/octet-stream',
        sizeBytes: MAX_STORED_UPLOAD_BYTES,
      }),
    ).toMatchObject({ ok: true });
  });

  it.each([
    { path: '', displayName: 'bundle.skill', mimeType: null, sizeBytes: 1 },
    { path: '/data/file\n.skill', displayName: 'bundle.skill', mimeType: null, sizeBytes: 1 },
    { path: '/data/file.skill', displayName: 'bad\nname.skill', mimeType: null, sizeBytes: 1 },
    { path: '/data/file.skill', displayName: 'bundle.skill', mimeType: 'bad\ntype', sizeBytes: 1 },
    { path: '/data/file.skill', displayName: 'bundle.skill', mimeType: null, sizeBytes: 0 },
    {
      path: '/data/file.skill',
      displayName: 'bundle.skill',
      mimeType: null,
      sizeBytes: MAX_STORED_UPLOAD_BYTES + 1,
    },
  ])('rejects unsafe or out-of-bounds metadata %#', (candidate) => {
    expect(makeStoredUpload(candidate).ok).toBe(false);
  });
});
