// ─── Learning Vault Port ──────────────────────────────────────────────────────
//
// The vault files the learning loop reads and the one log it appends to. Owned
// by the core so the shell (`orchestration/learn-command.ts`) and the adapter
// (`infra/learning-vault.ts`) both depend inward on it.

/** Port: the vault files the learning loop reads and the one log it appends to. */
export type LearningVault = Readonly<{
  readRegistry: () => Promise<string>;
  /** Vault-relative path → contents, or null when the file does not exist. */
  readNote: (path: string) => Promise<string | null>;
  readLog: () => Promise<string>;
  appendLog: (lines: readonly string[]) => Promise<void>;
  /** For `validate --sources`: vault-relative, absolute, or `~/` path. */
  sourceExists: (path: string) => Promise<boolean>;
}>;
