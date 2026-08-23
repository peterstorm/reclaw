// ─── Research Vault Lookup ──────────────────────────────────────────────────────
//
// Resolve a topic slug to its persisted NotebookLM notebook id by reading the
// hub note's YAML frontmatter. Used by /ask to find the notebook to query.

import { promises as fs } from 'node:fs';
import type { TopicSlug } from '../core/topic-slug.js';
import { err, ok } from '../core/types.js';
import type { Result } from '../core/types.js';
import {
  type VaultFilePath,
  type VaultRelativePath,
  parseVaultRelativePath,
} from '../core/vault-path.js';
import { createVaultWorkspace, formatVaultPathError } from './vault-workspace.js';

export type NotebookLookup = {
  readonly notebookId: string;
  readonly hubPath: VaultFilePath;
  readonly hubVaultPath: VaultRelativePath;
  readonly slug: TopicSlug;
  readonly topic: string;
};

const RESEARCH_BASE = 'reclaw/research';

/**
 * Read the root-confined hub note for a parsed topic slug and return its
 * NotebookLM id. The path is canonicalized again here because the filesystem
 * may contain symlinks even when the relative path itself is valid.
 */
export async function findNotebookByTopic(
  vaultBasePath: string,
  slug: TopicSlug,
): Promise<Result<NotebookLookup, string>> {
  const hubVaultPathResult = parseVaultRelativePath(`${RESEARCH_BASE}/${slug}/_index.md`);
  if (!hubVaultPathResult.ok) return err(hubVaultPathResult.error);
  const hubVaultPath = hubVaultPathResult.value;

  const workspace = await createVaultWorkspace(vaultBasePath);
  if (!workspace.ok) return err(formatVaultPathError(workspace.error));
  const resolvedHub = await workspace.value.resolveExistingFile(hubVaultPath);
  if (!resolvedHub.ok) {
    if (resolvedHub.error.kind === 'not-found') {
      return err(`No research topic at "${slug}". Expected hub note: ${hubVaultPath}`);
    }
    return err(
      `Cannot access research topic "${slug}": ${formatVaultPathError(resolvedHub.error)}`,
    );
  }
  const hubPath = resolvedHub.value;

  let raw: string;
  try {
    raw = await fs.readFile(hubPath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(`Failed to read research topic "${slug}": ${message}`);
  }

  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch === null) {
    return err(`Hub note for "${slug}" has no YAML frontmatter.`);
  }
  const fm = fmMatch[1] ?? '';

  const notebookId = parseYamlScalar(fm, 'notebook_id');
  if (notebookId === null || notebookId.length === 0) {
    return err(
      `Hub note for "${slug}" is missing notebook_id frontmatter. Run scripts/backfill-hub-notebook-ids.ts to populate it.`,
    );
  }

  const topic = parseYamlScalar(fm, 'title') ?? slug;

  return ok({ notebookId, hubPath, hubVaultPath, slug, topic });
}

/**
 * Minimal scalar-only YAML field parser. Handles `key: value`,
 * `key: 'value'`, and `key: "value"` (with doubled-quote escapes).
 * Returns null if the key is missing or the value is a list/map.
 */
function parseYamlScalar(yaml: string, key: string): string | null {
  const re = new RegExp(`^${escapeRegex(key)}:[ \\t]*(.*)$`, 'm');
  const m = yaml.match(re);
  if (m === null) return null;
  const v = (m[1] ?? '').trim();
  if (v.length === 0) return null;
  if (v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  if (v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\"/g, '"');
  }
  return v;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
