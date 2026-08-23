// ─── Vault Writer ──────────────────────────────────────────────────────────────
//
// Filesystem I/O adapter for writing Obsidian vault notes.
// This is the imperative shell over the pure vault-content.ts generators.
//
// FR-040: Writes research output to reclaw/research/{topic-slug}/
// FR-041: Hub note (_index.md) written at the root of the topic folder
// FR-042: Source notes written to Sources/ subfolder
// FR-043: Q&A notes written to QA/ subfolder
// FR-052: Emergency fallback if structured writes fail after MAX_WRITE_RETRIES

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { err, ok } from '../core/types.js';
import type { Result } from '../core/types.js';
import type { VaultNote } from '../core/vault-content.js';
import { type VaultFilePath, parseVaultRelativePath } from '../core/vault-path.js';
import {
  type VaultWorkspace,
  createVaultWorkspace,
  formatVaultPathError,
} from './vault-workspace.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum write retries before triggering emergency fallback. */
const MAX_WRITE_RETRIES = 3;

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Filesystem adapter for writing vault notes.
 *
 * - writeNotes: Write all structured notes (hub + sources + QA).
 *   Returns the absolute path to the hub note on success.
 *   Returns an error string if all retries are exhausted.
 *
 * - writeEmergencyNote: Write a single flat fallback note when structured
 *   writes fail. FR-052 fallback.
 *   Returns the absolute path to the emergency note on success.
 */
export type VaultWriterAdapter = {
  readonly writeNotes: (
    notes: readonly VaultNote[],
    basePath: string,
  ) => Promise<Result<string, string>>;
  readonly writeEmergencyNote: (
    note: VaultNote,
    basePath: string,
  ) => Promise<Result<string, string>>;
  /** Append content to an existing note file. */
  readonly appendToNote: (
    absolutePath: string,
    content: string,
    basePath: string,
  ) => Promise<Result<void, string>>;
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

type PreparedVaultNote = {
  readonly note: VaultNote;
  readonly absolutePath: VaultFilePath;
};

/** Write one already-preflighted note. */
async function writeVaultNote(prepared: PreparedVaultNote): Promise<void> {
  await fs.mkdir(path.dirname(prepared.absolutePath), { recursive: true });
  await fs.writeFile(prepared.absolutePath, prepared.note.content, 'utf8');
}

/** Parse and canonically contain every note before the first write occurs. */
async function prepareVaultNotes(
  notes: readonly VaultNote[],
  workspace: VaultWorkspace,
): Promise<Result<readonly PreparedVaultNote[], string>> {
  const prepared: PreparedVaultNote[] = [];
  for (const note of notes) {
    const relativePath = parseVaultRelativePath(note.relativePath);
    if (!relativePath.ok) {
      return err(`Invalid vault note path "${note.relativePath}": ${relativePath.error}`);
    }
    const absolutePath = await workspace.resolveFileForWrite(relativePath.value);
    if (!absolutePath.ok) return err(formatVaultPathError(absolutePath.error));
    prepared.push({ note, absolutePath: absolutePath.value });
  }
  return ok(prepared);
}

function findHubPath(notes: readonly PreparedVaultNote[]): VaultFilePath | null {
  return notes.find((entry) => entry.note.relativePath.endsWith('_index.md'))?.absolutePath ?? null;
}

/**
 * Attempt to write all notes with up to maxRetries attempts.
 * Returns the number of errors on the last attempt, or throws if exhausted.
 */
async function writeNotesWithRetry(
  notes: readonly PreparedVaultNote[],
  maxRetries: number,
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const errors: Array<{ note: VaultNote; error: unknown }> = [];

    for (const note of notes) {
      try {
        await writeVaultNote(note);
      } catch (e) {
        errors.push({ note: note.note, error: e });
      }
    }

    if (errors.length === 0) {
      return; // All notes written successfully
    }

    // Record the last error for reporting
    lastError = errors[0]?.error;

    if (attempt < maxRetries) {
      // Small delay before retry (exponential backoff: 100ms, 200ms)
      await new Promise<void>((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }

  // Exhausted retries
  const errorMsg = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Failed to write vault notes after ${maxRetries} attempts: ${errorMsg}`);
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a VaultWriterAdapter that writes notes to the real filesystem.
 *
 */
export function createVaultWriter(): VaultWriterAdapter {
  const writeNotes = async (
    notes: readonly VaultNote[],
    basePath: string,
  ): Promise<Result<string, string>> => {
    if (notes.length === 0) {
      return err('writeNotes called with empty notes array');
    }

    // Guard: verify hub note exists BEFORE any I/O.
    if (!notes.some((note) => note.relativePath.endsWith('_index.md'))) {
      return err('No hub note (_index.md) found in notes array');
    }

    const workspace = await createVaultWorkspace(basePath);
    if (!workspace.ok) return err(formatVaultPathError(workspace.error));
    const prepared = await prepareVaultNotes(notes, workspace.value);
    if (!prepared.ok) return prepared;
    const hubPath = findHubPath(prepared.value);
    if (hubPath === null) return err('No hub note (_index.md) found in prepared notes');

    try {
      await writeNotesWithRetry(prepared.value, MAX_WRITE_RETRIES);
      return ok(hubPath);
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      return err(`Vault write failed: ${errorMsg}`);
    }
  };

  const writeEmergencyNote = async (
    note: VaultNote,
    basePath: string,
  ): Promise<Result<string, string>> => {
    const workspace = await createVaultWorkspace(basePath);
    if (!workspace.ok) return err(formatVaultPathError(workspace.error));
    const prepared = await prepareVaultNotes([note], workspace.value);
    if (!prepared.ok) return prepared;
    const target = prepared.value[0];
    if (target === undefined) return err('Emergency note preparation produced no target');

    try {
      await writeVaultNote(target);
      return ok(target.absolutePath);
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      return err(`Emergency note write failed: ${errorMsg}`);
    }
  };

  const appendToNote = async (
    absolutePath: string,
    content: string,
    basePath: string,
  ): Promise<Result<void, string>> => {
    const workspace = await createVaultWorkspace(basePath);
    if (!workspace.ok) return err(formatVaultPathError(workspace.error));
    const target = await workspace.value.resolveExistingAbsoluteFile(absolutePath);
    if (!target.ok) return err(formatVaultPathError(target.error));

    try {
      await fs.appendFile(target.value, content, 'utf8');
      return ok(undefined);
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      return err(`Failed to append to note: ${errorMsg}`);
    }
  };

  return { writeNotes, writeEmergencyNote, appendToNote };
}
