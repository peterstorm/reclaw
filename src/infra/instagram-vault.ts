// ─── Instagram vault (filesystem adapter) ─────────────────────────────────────
//
// Implements the narrow InstagramVault port over the Obsidian vault on disk. Every path is
// resolved through VaultWorkspace, so symlink and traversal escapes are rejected, and files
// are written via tmp + rename so Obsidian Git never sees a half-written note.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { InstagramVault } from '../core/instagram-ingest.js';
import { createVaultWorkspace, formatVaultPathError } from './vault-workspace.js';

export async function fsInstagramVault(vaultRoot: string): Promise<InstagramVault> {
  const workspace = await createVaultWorkspace(vaultRoot);
  if (!workspace.ok) throw new Error(formatVaultPathError(workspace.error));
  const { resolveExistingFile, resolveFileForWrite } = workspace.value;

  const existingPath = async (relative: Parameters<typeof resolveExistingFile>[0]) => {
    const resolved = await resolveExistingFile(relative);
    if (resolved.ok) return resolved.value;
    if (resolved.error.kind === 'not-found') return null;
    throw new Error(formatVaultPathError(resolved.error));
  };

  return {
    exists: async (relative) => (await existingPath(relative)) !== null,

    read: async (relative) => {
      const file = await existingPath(relative);
      return file === null ? null : fs.readFile(file, 'utf8');
    },

    write: async (relative, content) => {
      const resolved = await resolveFileForWrite(relative);
      if (!resolved.ok) throw new Error(formatVaultPathError(resolved.error));
      await fs.mkdir(path.dirname(resolved.value), { recursive: true });
      const temp = `${resolved.value}.${process.pid}.tmp`;
      await fs.writeFile(temp, content, 'utf8');
      await fs.rename(temp, resolved.value);
    },
  };
}
