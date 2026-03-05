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
import type { VaultNote } from '../core/vault-content.js';
import { ok, err } from '../core/types.js';
import type { Result } from '../core/types.js';

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
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Write a single VaultNote to the filesystem.
 * Creates parent directories recursively if they don't exist.
 * Overwrites any existing file (idempotent — safe to retry).
 */
async function writeVaultNote(note: VaultNote, basePath: string): Promise<void> {
  const absolutePath = path.join(basePath, note.relativePath);
  const dir = path.dirname(absolutePath);

  // Create directory tree if needed
  await fs.mkdir(dir, { recursive: true });

  // Write file content (overwrites if exists — idempotent for retries)
  await fs.writeFile(absolutePath, note.content, 'utf8');
}

/**
 * Find the hub note (_index.md) in a list of vault notes and return
 * its absolute path.
 */
function findHubPath(notes: readonly VaultNote[], basePath: string): string | null {
  const hubNote = notes.find((n) => n.relativePath.endsWith('_index.md'));
  if (!hubNote) return null;
  return path.join(basePath, hubNote.relativePath);
}

/**
 * Attempt to write all notes with up to maxRetries attempts.
 * Returns the number of errors on the last attempt, or throws if exhausted.
 */
async function writeNotesWithRetry(
  notes: readonly VaultNote[],
  basePath: string,
  maxRetries: number,
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const errors: Array<{ note: VaultNote; error: unknown }> = [];

    for (const note of notes) {
      try {
        await writeVaultNote(note, basePath);
      } catch (e) {
        errors.push({ note, error: e });
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
 * Usage:
 *   const writer = createVaultWriter();
 *   const result = await writer.writeNotes(notes, '/path/to/vault');
 *   if (result.ok) { console.log('Hub at:', result.value); }
 *   else {
 *     // Fall back to emergency note
 *     const emergency = await writer.writeEmergencyNote(emergencyNote, basePath);
 *   }
 */
export function createVaultWriter(): VaultWriterAdapter {
  const writeNotes = async (
    notes: readonly VaultNote[],
    basePath: string,
  ): Promise<Result<string, string>> => {
    if (notes.length === 0) {
      return err('writeNotes called with empty notes array');
    }

    // Guard: verify hub note exists BEFORE any I/O
    const hubPath = findHubPath(notes, basePath);
    if (!hubPath) {
      return err('No hub note (_index.md) found in notes array');
    }

    try {
      await writeNotesWithRetry(notes, basePath, MAX_WRITE_RETRIES);
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
    try {
      await writeVaultNote(note, basePath);
      const absolutePath = path.join(basePath, note.relativePath);
      return ok(absolutePath);
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      return err(`Emergency note write failed: ${errorMsg}`);
    }
  };

  return { writeNotes, writeEmergencyNote };
}
