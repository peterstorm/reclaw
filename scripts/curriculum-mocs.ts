#!/usr/bin/env bun

/**
 * curriculum-mocs (I/O shell) — regenerate the per-domain Maps of Content under
 * learning/curriculum/<domain>/MOC.md from the registry. Run after editing the registry.
 *
 * Usage: bun scripts/curriculum-mocs.ts     (RECLAW_VAULT_ROOT overrides the vault path)
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { domainMocPath, renderDomainMoc } from '../src/core/curriculum-moc.js';
import { REGISTRY_PATH, parseCurriculum } from '../src/core/curriculum.js';
import { DEFAULT_VAULT_ROOT } from '../src/infra/learning-vault.js';

const root = process.env.RECLAW_VAULT_ROOT ?? DEFAULT_VAULT_ROOT;
const curriculum = parseCurriculum(await readFile(join(root, REGISTRY_PATH), 'utf8'));
if (!curriculum.ok) {
  process.stderr.write(`curriculum-mocs: registry invalid:\n- ${curriculum.error.join('\n- ')}\n`);
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
for (const domain of curriculum.value.domains) {
  const path = join(root, domainMocPath(domain));
  // Keep the original creation date stable across regenerations.
  const existing = await readFile(path, 'utf8').catch(() => '');
  const date = /^date: (\S+)$/m.exec(existing)?.[1] ?? today;
  await writeFile(path, renderDomainMoc(curriculum.value, domain, date), 'utf8');
  process.stdout.write(`wrote ${domainMocPath(domain)}\n`);
}
