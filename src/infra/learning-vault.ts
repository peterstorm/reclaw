// ─── Learning Vault (filesystem adapter) ──────────────────────────────────────
//
// Implements the LearningVault port over the Obsidian vault on disk. The study log is
// appended with O_APPEND (`appendFile`), so concurrent single-line appends from two
// skill sessions cannot interleave mid-line on a local filesystem. The registry is
// replaced atomically (write a sibling temp file, then rename), so a repair interrupted
// mid-write leaves the old file intact.

import type { Dirent } from 'node:fs';
import { access, appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { REGISTRY_PATH, STUDY_LOG_PATH } from '../core/curriculum.js';
import type { LearningVault } from '../core/learning-vault-port.js';

const readIfExists = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
};

export const DEFAULT_VAULT_ROOT = join(homedir(), 'dev/notes/remotevault');

/** Directories that never hold a curriculum source: metadata, dependencies, trash. */
const SKIP_DIRS: ReadonlySet<string> = new Set(['.git', 'node_modules', '.obsidian', '.trash']);

/** Every markdown file under `root`, as paths relative to it. Unreadable dirs are skipped. */
async function walkMarkdown(root: string): Promise<readonly string[]> {
  const found: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await visit(path);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        found.push(relative(root, path));
      }
    }
  };
  await visit(root);
  return found;
}

export function fsLearningVault(vaultRoot: string, home: string = homedir()): LearningVault {
  const inVault = (relativePath: string) => join(vaultRoot, relativePath);
  const logPath = inVault(STUDY_LOG_PATH);
  const resolveSource = (path: string): string => {
    if (path.startsWith('~/')) return join(home, path.slice(2));
    return isAbsolute(path) ? path : inVault(path);
  };

  return {
    readRegistry: async () => {
      const text = await readIfExists(inVault(REGISTRY_PATH));
      if (text === null)
        throw new Error(`curriculum registry not found at ${inVault(REGISTRY_PATH)}`);
      return text;
    },
    readNote: (path) => readIfExists(inVault(path)),
    readLog: async () => (await readIfExists(logPath)) ?? '',
    appendLog: async (lines) => {
      if (lines.length === 0) return;
      await mkdir(dirname(logPath), { recursive: true });
      await appendFile(logPath, `${lines.join('\n')}\n`, 'utf8');
    },
    sourceExists: async (path) => {
      try {
        await access(resolveSource(path));
        return true;
      } catch {
        return false;
      }
    },
    indexByBasename: async (root) => {
      const scoped = root.startsWith('~/');
      const dir = scoped ? join(home, root.slice(2)) : inVault(root);
      const index = new Map<string, string[]>();
      for (const rel of await walkMarkdown(dir)) {
        const declared = scoped ? `${root}/${rel.split('\\').join('/')}` : rel;
        const name = basename(declared);
        const paths = index.get(name) ?? [];
        paths.push(declared);
        index.set(name, paths);
      }
      return index;
    },
    writeRegistry: async (text) => {
      const path = inVault(REGISTRY_PATH);
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.tmp-${process.pid}`;
      await writeFile(temp, text, 'utf8');
      await rename(temp, path);
    },
  };
}
