// ─── Research Q&A Writer ────────────────────────────────────────────────────────
//
// Persists a /ask question/answer pair into the same Obsidian layout the
// original /research flow produces:
//
//   reclaw/research/<slug>/QA/<truncated-question>.md   ← child note
//   reclaw/research/<slug>/_index.md                    ← hub gets a wikilink
//
// Reuses buildQANote() so the file format is indistinguishable from canonical
// research output. Idempotent: re-asking the same question overwrites the QA
// file and does not duplicate the hub link.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { SourceMeta } from '../core/research-types.js';
import { err, ok } from '../core/types.js';
import type { Result } from '../core/types.js';
import { buildQANote } from '../core/vault-content.js';
import {
  type VaultFilePath,
  type VaultRelativePath,
  parseVaultRelativePath,
} from '../core/vault-path.js';
import type { NotebookLookup } from './research-vault-lookup.js';
import { createVaultWorkspace, formatVaultPathError } from './vault-workspace.js';

export type AskAnswerInput = {
  readonly vaultBasePath: string;
  readonly lookup: NotebookLookup;
  readonly question: string;
  readonly resolvedAnswer: string;
  readonly citedSources: readonly SourceMeta[];
};

export type AskAnswerOutput = {
  readonly qaAbsPath: VaultFilePath;
  readonly qaVaultPath: VaultRelativePath;
  readonly hubUpdated: boolean;
};

export async function appendAskAnswer(
  input: AskAnswerInput,
): Promise<Result<AskAnswerOutput, string>> {
  const note = buildQANote(
    input.question,
    input.resolvedAnswer,
    input.citedSources,
    input.lookup.slug,
    input.lookup.hubVaultPath,
  );

  const qaVaultPathResult = parseVaultRelativePath(note.relativePath);
  if (!qaVaultPathResult.ok) return err(`Invalid generated QA path: ${qaVaultPathResult.error}`);
  const qaVaultPath = qaVaultPathResult.value;

  const workspace = await createVaultWorkspace(input.vaultBasePath);
  if (!workspace.ok) return err(formatVaultPathError(workspace.error));

  // Preflight both paths before creating the child note. A forged/stale lookup
  // must not leave a partial QA file when its hub resolves outside the vault.
  const hubPathResult = await workspace.value.resolveExistingAbsoluteFile(input.lookup.hubPath);
  if (!hubPathResult.ok)
    return err(`Unsafe hub path: ${formatVaultPathError(hubPathResult.error)}`);
  const qaAbsPathResult = await workspace.value.resolveFileForWrite(qaVaultPath);
  if (!qaAbsPathResult.ok) return err(formatVaultPathError(qaAbsPathResult.error));
  const qaAbsPath = qaAbsPathResult.value;

  try {
    await fs.mkdir(path.dirname(qaAbsPath), { recursive: true });
    await fs.writeFile(qaAbsPath, note.content, 'utf8');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`Failed to write QA note at ${qaAbsPath}: ${msg}`);
  }

  // The wikilink the hub uses for sibling QA notes is just the basename —
  // matching the format buildHubNote produces during the original /research run.
  const wikilinkBase = path.basename(note.relativePath, '.md');
  const wikilinkLine = `- [[${wikilinkBase}]]`;

  let hubUpdated = false;
  try {
    hubUpdated = await ensureWikilinkInHubQASection(hubPathResult.value, wikilinkLine);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`QA note written but hub update failed: ${msg}`);
  }

  return ok({ qaAbsPath, qaVaultPath, hubUpdated });
}

/**
 * Add `wikilinkLine` to the hub's `## Questions & Answers` section if absent.
 * Replaces a `_No questions answered._` placeholder if present, and creates
 * the section at end-of-file if the heading is missing.
 *
 * Returns true if the file was modified.
 */
async function ensureWikilinkInHubQASection(
  hubAbsPath: string,
  wikilinkLine: string,
): Promise<boolean> {
  const raw = await fs.readFile(hubAbsPath, 'utf8');
  if (raw.includes(wikilinkLine)) return false;

  const heading = '## Questions & Answers';
  const headingIdx = raw.indexOf(heading);

  if (headingIdx === -1) {
    const trimmed = raw.replace(/\s+$/, '');
    const updated = `${trimmed}\n\n${heading}\n\n${wikilinkLine}\n`;
    await fs.writeFile(hubAbsPath, updated, 'utf8');
    return true;
  }

  // Section body = everything between the heading line and the next "## "
  // heading (or EOF).
  const headingLineEnd = raw.indexOf('\n', headingIdx);
  const bodyStart = headingLineEnd === -1 ? raw.length : headingLineEnd + 1;
  const nextHeading = /\n## /.exec(raw.slice(bodyStart));
  const bodyEnd = nextHeading ? bodyStart + nextHeading.index + 1 : raw.length;

  const before = raw.slice(0, bodyStart); // ends with "## Questions & Answers\n"
  const body = raw.slice(bodyStart, bodyEnd);
  const after = raw.slice(bodyEnd);

  const lines = body.split('\n');
  const filtered = lines.filter((l) => l.trim() !== '_No questions answered._');
  while (filtered.length > 0 && filtered[filtered.length - 1]?.trim() === '') filtered.pop();
  while (filtered.length > 0 && filtered[0]?.trim() === '') filtered.shift();
  filtered.push(wikilinkLine);

  const newBody = `\n${filtered.join('\n')}\n\n`;
  const tail = after.replace(/^\n+/, '');
  const updated = `${before}${newBody}${tail}`;

  await fs.writeFile(hubAbsPath, updated, 'utf8');
  return true;
}
