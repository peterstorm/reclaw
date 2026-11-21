// ─── Learning Vault Port ──────────────────────────────────────────────────────
//
// The vault files the learning loop reads, the one log it appends to, and the one
// repair it may write. Owned by the core so the shell (`orchestration/learn-command.ts`)
// and the adapter (`infra/learning-vault.ts`) both depend inward on it.

/** Port: the vault files the learning loop reads and the two things it writes. */
export type LearningVault = Readonly<{
  readRegistry: () => Promise<string>;
  /** Vault-relative path → contents, or null when the file does not exist. */
  readNote: (path: string) => Promise<string | null>;
  readLog: () => Promise<string>;
  appendLog: (lines: readonly string[]) => Promise<void>;
  /** For `validate --sources`: vault-relative, absolute, or `~/` path. */
  sourceExists: (path: string) => Promise<boolean>;
  /**
   * Basename → declared-form paths (vault-relative, or `~/` outside the vault), for every
   * note under `root`: '' is the vault, `~/x` is that home subtree. Rename repair only.
   */
  indexByBasename: (root: string) => Promise<ReadonlyMap<string, readonly string[]>>;
  /** Replace the curriculum registry — the only write outside the log, and only on `--apply`. */
  writeRegistry: (text: string) => Promise<void>;
}>;
