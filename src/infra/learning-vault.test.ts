// Contract test: the filesystem adapter and the in-memory fake must agree on every
// observable behaviour of the LearningVault port, so tests that use the fake prove
// something about production.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fakeVault, notePath, renderNote, renderRegistry } from '../core/__fixtures__/learning.js';
import { REGISTRY_PATH } from '../core/curriculum.js';
import type { LearningVault } from '../core/learning-vault-port.js';
import { fsLearningVault } from './learning-vault.js';

const registry = renderRegistry([{ slug: 'a' }]);
const note = renderNote({ slug: 'a', lessons: 2 });
const roots: string[] = [];

async function fsVault(): Promise<LearningVault> {
  const root = await mkdtemp(join(tmpdir(), 'learning-vault-'));
  roots.push(root);
  for (const [path, content] of [
    [REGISTRY_PATH, registry],
    [notePath('a'), note],
  ] as const) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return fsLearningVault(root);
}

afterAll(async () => {
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
});

describe.each([
  ['fsLearningVault', fsVault],
  ['fakeVault', async () => fakeVault(registry, { [notePath('a')]: note })],
] as const)('LearningVault contract — %s', (_, make) => {
  it('reads the registry and existing notes; a missing note is null', async () => {
    const vault = await make();
    expect(await vault.readRegistry()).toBe(registry);
    expect(await vault.readNote(notePath('a'))).toBe(note);
    expect(await vault.readNote(notePath('missing'))).toBeNull();
  });

  it('starts with an empty log and appends whole lines in order', async () => {
    const vault = await make();
    expect(await vault.readLog()).toBe('');
    await vault.appendLog(['{"n":1}', '{"n":2}']);
    await vault.appendLog(['{"n":3}']);
    expect(await vault.readLog()).toBe('{"n":1}\n{"n":2}\n{"n":3}\n');
  });

  it('treats an empty append as a no-op', async () => {
    const vault = await make();
    await vault.appendLog([]);
    expect(await vault.readLog()).toBe('');
  });

  it('reports which source paths exist', async () => {
    const vault = await make();
    expect(await vault.sourceExists(REGISTRY_PATH)).toBe(true);
    expect(await vault.sourceExists('nope/missing.md')).toBe(false);
  });

  it('indexes note basenames, so a renamed source can be found by name', async () => {
    const vault = await make();
    const index = await vault.indexByBasename('');
    expect(index.get('a.md')).toEqual([notePath('a')]);
    expect(index.get('registry.yaml')).toBeUndefined();
  });

  it('replaces the registry, and reads the replacement back', async () => {
    const vault = await make();
    await vault.writeRegistry('# rewritten\n');
    expect(await vault.readRegistry()).toBe('# rewritten\n');
  });
});

describe('fsLearningVault outside the vault', () => {
  it('indexes a ~/ subtree in declared form, never the whole home', async () => {
    const home = await mkdtemp(join(tmpdir(), 'learning-home-'));
    roots.push(home);
    await mkdir(join(home, '.dotfiles/docs/runbooks'), { recursive: true });
    await writeFile(join(home, '.dotfiles/docs/runbooks/triage.md'), '# triage\n');
    await writeFile(join(home, 'elsewhere.md'), '# elsewhere\n');

    const vaultRoot = await mkdtemp(join(tmpdir(), 'learning-vault-'));
    roots.push(vaultRoot);
    const vault = fsLearningVault(vaultRoot, home);
    const index = await vault.indexByBasename('~/.dotfiles');
    expect(index.get('triage.md')).toEqual(['~/.dotfiles/docs/runbooks/triage.md']);
    expect(index.get('elsewhere.md')).toBeUndefined();
  });
});
