// ─── Learning Vault Port ──────────────────────────────────────────────────────
//
// The vault files the learning loop reads, the one log it appends to, and the one
// repair it may write. Owned by the core so the shell (`orchestration/learn-command.ts`)
// and the adapter (`infra/learning-vault.ts`) both depend inward on it.

import type { VaultScope } from './source-repair.js';

/**
 * What a basename walk found under one root, and what it could not see. `unreadable` is the
 * point: a directory that cannot be listed makes the index partial, and a rename planned
 * from a partial index can invent a fix or lose one. The caller must report and refuse, not
 * treat a missing subtree as empty.
 */
export type BasenameIndex = Readonly<{
  /** basename → declared-form paths (vault-relative, or `~/` outside the vault). */
  byName: ReadonlyMap<string, readonly string[]>;
  /** Roots that could not be listed, in declared form. */
  unreadable: readonly string[];
}>;

/** Port: the vault files the learning loop reads and the two things it writes. */
export type LearningVault = Readonly<{
  readRegistry: () => Promise<string>;
  /** Vault-relative path → contents, or null when the file does not exist. */
  readNote: (path: string) => Promise<string | null>;
  readLog: () => Promise<string>;
  appendLog: (lines: readonly string[]) => Promise<void>;
  /**
   * For `validate --sources`: vault-relative, absolute, or `~/` path. `false` means the
   * path is genuinely absent; an unreadable parent directory throws rather than answering
   * "no", because that answer would claim a file is gone when nobody looked.
   */
  sourceExists: (path: string) => Promise<boolean>;
  /**
   * Every regular markdown file under a root, keyed by basename. Symlinked directories and
   * files are skipped, as are `.git`, `node_modules`, `.obsidian` and `.trash`; an unlistable
   * directory is reported in `unreadable` rather than silently omitted. Rename repair only.
   */
  indexByBasename: (scope: VaultScope) => Promise<BasenameIndex>;
  /** Replace the curriculum registry — the only write outside the log, and only on `--apply`. */
  writeRegistry: (text: string) => Promise<void>;
}>;
