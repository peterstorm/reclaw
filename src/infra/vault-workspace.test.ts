import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseVaultRelativePath } from '../core/vault-path.js';
import { createVaultWorkspace } from './vault-workspace.js';

function relativePath(raw: string) {
  const parsed = parseVaultRelativePath(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

describe('createVaultWorkspace', () => {
  let parent: string;
  let vault: string;
  let outside: string;

  beforeEach(async () => {
    parent = await fs.mkdtemp(path.join(tmpdir(), 'vault-workspace-test-'));
    vault = path.join(parent, 'vault');
    outside = path.join(parent, 'vault-old');
    await fs.mkdir(vault);
    await fs.mkdir(outside);
  });

  afterEach(async () => {
    await fs.rm(parent, { recursive: true, force: true });
  });

  it('resolves an existing regular file inside the canonical root', async () => {
    await fs.mkdir(path.join(vault, 'notes'));
    await fs.writeFile(path.join(vault, 'notes', 'inside.md'), '# Inside');
    const workspace = await createVaultWorkspace(vault);
    if (!workspace.ok) throw new Error(workspace.error.kind);

    const result = await workspace.value.resolveExistingFile(relativePath('notes/inside.md'));

    expect(result).toEqual({ ok: true, value: path.join(vault, 'notes', 'inside.md') });
  });

  it('resolves a new write below the deepest existing ancestor', async () => {
    const workspace = await createVaultWorkspace(vault);
    if (!workspace.ok) throw new Error(workspace.error.kind);

    const result = await workspace.value.resolveFileForWrite(relativePath('new/nested/note.md'));

    expect(result).toEqual({ ok: true, value: path.join(vault, 'new', 'nested', 'note.md') });
  });

  it('rejects prefix-collision absolute paths outside the vault', async () => {
    const outsideFile = path.join(outside, 'note.md');
    await fs.writeFile(outsideFile, '# Outside');
    const workspace = await createVaultWorkspace(vault);
    if (!workspace.ok) throw new Error(workspace.error.kind);

    const result = await workspace.value.resolveExistingAbsoluteFile(outsideFile);

    expect(result).toEqual({ ok: false, error: { kind: 'outside-vault', path: outsideFile } });
  });

  it('rejects an existing file symlink that escapes the vault', async () => {
    const outsideFile = path.join(outside, 'secret.md');
    await fs.writeFile(outsideFile, '# Secret');
    await fs.symlink(outsideFile, path.join(vault, 'linked.md'));
    const workspace = await createVaultWorkspace(vault);
    if (!workspace.ok) throw new Error(workspace.error.kind);

    const result = await workspace.value.resolveExistingFile(relativePath('linked.md'));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('outside-vault');
  });

  it('rejects a write through a directory symlink that escapes the vault', async () => {
    await fs.symlink(outside, path.join(vault, 'escaped'));
    const workspace = await createVaultWorkspace(vault);
    if (!workspace.ok) throw new Error(workspace.error.kind);

    const result = await workspace.value.resolveFileForWrite(relativePath('escaped/new.md'));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('outside-vault');
  });

  it('rejects a broken final symlink instead of treating it as a new safe file', async () => {
    const missingOutsideFile = path.join(outside, 'not-created.md');
    await fs.symlink(missingOutsideFile, path.join(vault, 'broken.md'));
    const workspace = await createVaultWorkspace(vault);
    if (!workspace.ok) throw new Error(workspace.error.kind);

    const result = await workspace.value.resolveFileForWrite(relativePath('broken.md'));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('outside-vault');
  });

  it('allows an internal symlink only when its canonical target remains inside the vault', async () => {
    await fs.mkdir(path.join(vault, 'real'));
    await fs.writeFile(path.join(vault, 'real', 'note.md'), '# Real');
    await fs.symlink(path.join(vault, 'real'), path.join(vault, 'alias'));
    const workspace = await createVaultWorkspace(vault);
    if (!workspace.ok) throw new Error(workspace.error.kind);

    const readResult = await workspace.value.resolveExistingFile(relativePath('alias/note.md'));
    const writeResult = await workspace.value.resolveFileForWrite(relativePath('alias/new.md'));

    expect(readResult).toEqual({ ok: true, value: path.join(vault, 'real', 'note.md') });
    expect(writeResult).toEqual({ ok: true, value: path.join(vault, 'real', 'new.md') });
  });

  it('fails explicitly when the configured root does not exist', async () => {
    const missing = path.join(parent, 'missing');

    const result = await createVaultWorkspace(missing);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('vault-root-unavailable');
  });
});
