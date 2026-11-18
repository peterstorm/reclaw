import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createScriptStateDir } from './script-workdir.js';

const dirs: string[] = [];

const makeTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'reclaw-script-state-'));
  dirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('createScriptStateDir', () => {
  it('reads a written file back', async () => {
    const root = await makeTempDir();
    const dir = createScriptStateDir(root);
    await dir.writeFileAtomic('state.json', '{"reported":{}}');
    await expect(dir.readFile('state.json')).resolves.toBe('{"reported":{}}');
  });

  it('resolves undefined for an absent file (absence is a value)', async () => {
    const root = await makeTempDir();
    const dir = createScriptStateDir(root);
    await expect(dir.readFile('missing.json')).resolves.toBeUndefined();
  });

  it('writes atomically: no temp file left behind, content complete', async () => {
    const root = await makeTempDir();
    const dir = createScriptStateDir(root);
    await dir.writeFileAtomic('state.json', 'x'.repeat(10_000));
    const entries = await stat(join(root, 'state.json'));
    expect(entries.isFile()).toBe(true);
    await expect(dir.readFile('state.json')).resolves.toBe('x'.repeat(10_000));
    // The temp file was renamed away — the directory holds exactly one entry.
    const { readdir } = await import('node:fs/promises');
    await expect(readdir(root)).resolves.toEqual(['state.json']);
  });

  it('overwrites an existing file', async () => {
    const root = await makeTempDir();
    const dir = createScriptStateDir(root);
    await dir.writeFileAtomic('state.json', 'one');
    await dir.writeFileAtomic('state.json', 'two');
    await expect(dir.readFile('state.json')).resolves.toBe('two');
  });

  it('creates the root directory on first write', async () => {
    const root = join(await makeTempDir(), 'nested', 'skill-id');
    const dir = createScriptStateDir(root);
    await dir.writeFileAtomic('state.json', '{}');
    await expect(dir.readFile('state.json')).resolves.toBe('{}');
  });

  it('removes an existing file and tolerates removing an absent one', async () => {
    const root = await makeTempDir();
    const dir = createScriptStateDir(root);
    await dir.writeFileAtomic('error.json', '{"cause":"login-failed"}');
    await dir.remove('error.json');
    await expect(dir.readFile('error.json')).resolves.toBeUndefined();
    await expect(dir.remove('error.json')).resolves.toBeUndefined();
  });

  it('raw fs access still works for non-state tooling (the root is a plain directory)', async () => {
    const root = await makeTempDir();
    const dir = createScriptStateDir(root);
    await dir.writeFileAtomic('tasks.json', '[]');
    await expect(readFile(join(root, 'tasks.json'), 'utf8')).resolves.toBe('[]');
  });
});
