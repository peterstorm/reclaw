import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseVaultRelativePath } from '../core/vault-path.js';
import { fsInstagramVault } from './instagram-vault.js';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'ig-vault-test-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const rel = (raw: string) => {
  const r = parseVaultRelativePath(raw);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe('fsInstagramVault', () => {
  it('writes (creating folders), reads back, and reports existence', async () => {
    const vault = await fsInstagramVault(root);
    const path = rel('media/instagram/someone/abc.md');

    expect(await vault.exists(path)).toBe(false);
    expect(await vault.read(path)).toBeNull();

    await vault.write(path, 'hello');
    expect(await vault.exists(path)).toBe(true);
    expect(await vault.read(path)).toBe('hello');
    expect(await fs.readFile(join(root, 'media/instagram/someone/abc.md'), 'utf8')).toBe('hello');
  });

  it('overwrites atomically and leaves no temp files behind', async () => {
    const vault = await fsInstagramVault(root);
    const path = rel('note.md');
    await vault.write(path, 'one');
    await vault.write(path, 'two');
    expect(await vault.read(path)).toBe('two');
    expect(await fs.readdir(root)).toEqual(['note.md']);
  });

  it('refuses to write through a symlink that escapes the vault', async () => {
    const outside = await fs.mkdtemp(join(tmpdir(), 'ig-outside-'));
    try {
      await fs.symlink(outside, join(root, 'escape'));
      const vault = await fsInstagramVault(root);
      await expect(vault.write(rel('escape/x.md'), 'nope')).rejects.toThrow(/escapes/);
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('fails fast when the vault root does not exist', async () => {
    await expect(fsInstagramVault(join(root, 'missing'))).rejects.toThrow(/unavailable/);
  });
});
