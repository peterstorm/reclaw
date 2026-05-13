#!/usr/bin/env bun
/**
 * One-off: copy notebook_id from any Source note's frontmatter into the
 * sibling _index.md, so /ask can resolve a topic slug to its notebook
 * without scanning Source files.
 *
 * Idempotent — skips hubs that already carry notebook_id.
 *
 * Usage:
 *   OBSIDIAN_VAULT_PATH=/path/to/vault bun scripts/backfill-hub-notebook-ids.ts
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const VAULT = process.env['OBSIDIAN_VAULT_PATH'];
if (!VAULT) {
  console.error('Set OBSIDIAN_VAULT_PATH (or run via reclaw-env).');
  process.exit(1);
}

const RESEARCH_DIR = path.join(VAULT, 'reclaw', 'research');

const NOTEBOOK_ID_RE = /^notebook_id:\s*['"]?([^'"\s]+)['"]?\s*$/m;

async function readNotebookIdFromSources(sourcesDir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(sourcesDir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const text = await fs.readFile(path.join(sourcesDir, name), 'utf8');
    const m = text.match(NOTEBOOK_ID_RE);
    if (m) return m[1]!.trim();
  }
  return null;
}

function injectNotebookIdIntoFrontmatter(hubText: string, notebookId: string): string {
  // Insert `notebook_id: 'X'` right before the closing `---`
  // of the first frontmatter block. Preserves line endings.
  return hubText.replace(
    /^(---\n[\s\S]*?)(\n---\n)/,
    `$1\nnotebook_id: '${notebookId}'$2`,
  );
}

async function main(): Promise<void> {
  let topicDirs: string[];
  try {
    const entries = await fs.readdir(RESEARCH_DIR, { withFileTypes: true });
    topicDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (e) {
    console.error(`Cannot read ${RESEARCH_DIR}:`, e);
    process.exit(1);
  }

  let updated = 0;
  let skipped = 0;
  let missing = 0;

  for (const topic of topicDirs.sort()) {
    const hubPath = path.join(RESEARCH_DIR, topic, '_index.md');
    let hubText: string;
    try {
      hubText = await fs.readFile(hubPath, 'utf8');
    } catch {
      continue; // no hub note — skip silently
    }

    if (NOTEBOOK_ID_RE.test(hubText)) {
      console.log(`✓ ${topic} (already has notebook_id)`);
      skipped += 1;
      continue;
    }

    const notebookId = await readNotebookIdFromSources(path.join(RESEARCH_DIR, topic, 'Sources'));
    if (notebookId === null) {
      console.log(`✗ ${topic} (no notebook_id found in Sources/)`);
      missing += 1;
      continue;
    }

    const updatedText = injectNotebookIdIntoFrontmatter(hubText, notebookId);
    if (updatedText === hubText) {
      console.log(`✗ ${topic} (frontmatter not editable — manual review)`);
      missing += 1;
      continue;
    }
    await fs.writeFile(hubPath, updatedText, 'utf8');
    console.log(`+ ${topic} → ${notebookId}`);
    updated += 1;
  }

  console.log(`\nDone: ${updated} updated, ${skipped} already had it, ${missing} missing.`);
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
