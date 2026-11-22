// ─── Learning Vault (filesystem adapter) ──────────────────────────────────────
//
// Implements the LearningVault port over the Obsidian vault on disk. The study log is
// appended with O_APPEND (`appendFile`), so concurrent single-line appends from two
// skill sessions cannot interleave mid-line on a local filesystem. The registry is
// replaced atomically (write a sibling temp file, then rename), so a repair interrupted
// mid-write leaves the old file intact.

import type { Dirent } from 'node:fs';
import {
  access,
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { REGISTRY_PATH, STUDY_LOG_PATH } from '../core/curriculum.js';
import type { BasenameIndex, LearningVault } from '../core/learning-vault-port.js';
import type { VaultScope } from '../core/source-repair.js';

const readIfExists = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
};

/** Paths that mean "there is no such file", as opposed to "nobody could look". */
const ABSENT: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);

const errorCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code;

export const DEFAULT_VAULT_ROOT = join(homedir(), 'dev/notes/remotevault');

/** Directories that never hold a curriculum source: metadata, dependencies, trash. */
const SKIP_DIRS: ReadonlySet<string> = new Set(['.git', 'node_modules', '.obsidian', '.trash']);

type Walked = Readonly<{ files: readonly string[]; unreadable: readonly string[] }>;

/** Every markdown file under `dir`, as paths relative to `dir`; unlisted dirs are reported. */
async function walkMarkdown(dir: string, root: string): Promise<Walked> {
  const files: string[] = [];
  const unreadable: string[] = [];
  const visit = async (current: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      unreadable.push(relative(root, current) || '.');
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await visit(path);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(relative(root, path));
      }
    }
  };
  await visit(dir);
  return { files, unreadable };
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
        return (await stat(resolveSource(path))).isFile();
      } catch (e) {
        if (ABSENT.has(errorCode(e) ?? '')) return false;
        throw e;
      }
    },
    indexByBasename: async (scope: VaultScope): Promise<BasenameIndex> => {
      const dir = scope.kind === 'home' ? join(home, scope.subtree.slice(2)) : inVault('');
      const prefix = scope.kind === 'home' ? scope.subtree : '';
      const walked = await walkMarkdown(dir, dir);
      const byName = new Map<string, string[]>();
      for (const rel of walked.files) {
        const declared = posixJoin(prefix, rel);
        const name = basename(declared);
        const paths = byName.get(name) ?? [];
        paths.push(declared);
        byName.set(name, paths);
      }
      return {
        byName,
        unreadable: walked.unreadable.map((rel) =>
          rel === '.' ? prefix || '.' : posixJoin(prefix, rel),
        ),
      };
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

/** Declared paths always use `/`, whichever separator the filesystem produced. */
const posixJoin = (prefix: string, path: string): string => {
  const normalized = path.split('\\').join('/');
  return prefix === '' ? normalized : `${prefix}/${normalized}`;
};
