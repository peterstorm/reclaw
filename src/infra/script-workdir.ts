import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ScriptStateDir } from '../core/script-skill.js';

const TMP_SUFFIX = '.tmp';

const isEnoent = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * The one ScriptStateDir adapter: a directory on the local filesystem.
 * `readFile` maps a missing file to `undefined`; every other read error throws.
 * `writeFileAtomic` writes a temp file in the same directory and renames it —
 * a crash between the two leaves the previous contents intact.
 */
export const createScriptStateDir = (root: string): ScriptStateDir => ({
  readFile: async (name) => {
    try {
      return await readFile(join(root, name), 'utf8');
    } catch (error) {
      if (isEnoent(error)) return undefined;
      throw error;
    }
  },
  writeFileAtomic: async (name, contents) => {
    await mkdir(root, { recursive: true });
    const tempPath = join(root, `${name}${TMP_SUFFIX}`);
    await writeFile(tempPath, contents, 'utf8');
    await rename(tempPath, join(root, name));
  },
  remove: async (name) => {
    await rm(join(root, name), { force: true });
  },
});
