// ─── Research Vault Lookup ──────────────────────────────────────────────────────
//
// Resolve a topic slug to its persisted NotebookLM notebook id by reading the
// hub note's YAML frontmatter. Used by /ask to find the notebook to query.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { ok, err } from '../core/types.js';
import type { Result } from '../core/types.js';

export type NotebookLookup = {
  readonly notebookId: string;
  readonly hubPath: string;
  readonly hubVaultPath: string;
  readonly slug: string;
  readonly topic: string;
};

const RESEARCH_BASE = 'reclaw/research';

/**
 * Accept either a leaf slug ("my-topic") or a full vault path
 * ("reclaw/research/my-topic" or ".../my-topic/_index"). Returns the leaf.
 */
export function normalizeTopicSlug(raw: string): string {
  return raw
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\/_index(?:\.md)?$/, '')
    .replace(/^reclaw\/research\//, '');
}

/**
 * Read the hub note for a topic slug and return its notebook id.
 * Errors with a user-facing message if the hub note is missing or
 * lacks a `notebook_id:` frontmatter field.
 */
export async function findNotebookByTopic(
  vaultBasePath: string,
  rawSlug: string,
): Promise<Result<NotebookLookup, string>> {
  const slug = normalizeTopicSlug(rawSlug);
  if (slug.length === 0) {
    return err('Topic slug must not be empty.');
  }
  const hubVaultPath = `${RESEARCH_BASE}/${slug}/_index.md`;
  const hubPath = path.join(vaultBasePath, hubVaultPath);

  let raw: string;
  try {
    raw = await fs.readFile(hubPath, 'utf8');
  } catch {
    return err(
      `No research topic at "${slug}". Expected hub note: ${hubVaultPath}`,
    );
  }

  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch === null) {
    return err(`Hub note for "${slug}" has no YAML frontmatter.`);
  }
  const fm = fmMatch[1] ?? '';

  const notebookId = parseYamlScalar(fm, 'notebook_id');
  if (notebookId === null || notebookId.length === 0) {
    return err(
      `Hub note for "${slug}" is missing notebook_id frontmatter. ` +
        `Run scripts/backfill-hub-notebook-ids.ts to populate it.`,
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
