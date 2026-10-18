// ─── Learning Vault (filesystem adapter) ──────────────────────────────────────
//
// Implements the LearningVault port over the Obsidian vault on disk. The study log is
// appended with O_APPEND (`appendFile`), so concurrent single-line appends from two
// skill sessions cannot interleave mid-line on a local filesystem.

import { access, appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { REGISTRY_PATH, STUDY_LOG_PATH } from '../core/curriculum.js';
import type { LearningVault } from '../orchestration/learn-command.js';

const readIfExists = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
};

export const DEFAULT_VAULT_ROOT = join(homedir(), 'dev/notes/remotevault');

export function fsLearningVault(vaultRoot: string): LearningVault {
  const inVault = (relative: string) => join(vaultRoot, relative);
  const logPath = inVault(STUDY_LOG_PATH);
  const resolveSource = (path: string) =>
    path.startsWith('~/')
      ? join(homedir(), path.slice(2))
      : isAbsolute(path)
        ? path
        : inVault(path);

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
  };
}
