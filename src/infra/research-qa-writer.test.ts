import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SourceMeta } from '../core/research-types.js';
import { parseTopicSlugReference } from '../core/topic-slug.js';
import { type VaultFilePath, parseVaultRelativePath } from '../core/vault-path.js';
import { appendAskAnswer } from './research-qa-writer.js';
import type { NotebookLookup } from './research-vault-lookup.js';

type Fixture = {
  readonly vault: string;
  readonly lookup: NotebookLookup;
  readonly cleanup: () => void;
};

function setupVault(hubBody?: string): Fixture {
  const vault = mkdtempSync(join(tmpdir(), 'reclaw-qa-'));
  const slugResult = parseTopicSlugReference('demo-topic');
  if (!slugResult.ok) throw new Error(slugResult.error);
  const slug = slugResult.value;
  const hubVaultPathResult = parseVaultRelativePath(`reclaw/research/${slug}/_index.md`);
  if (!hubVaultPathResult.ok) throw new Error(hubVaultPathResult.error);
  const hubVaultPath = hubVaultPathResult.value;
  const hubPath = join(vault, hubVaultPath);
  mkdirSync(join(vault, 'reclaw/research', slug), { recursive: true });

  const defaultBody = [
    '---',
    "title: 'Demo'",
    `topic_slug: ${slug}`,
    '---',
    '',
    '# Demo',
    '',
    '## Sources',
    '',
    '_No sources ingested._',
    '',
    '## Questions & Answers',
    '',
    '_No questions answered._',
    '',
  ].join('\n');

  writeFileSync(hubPath, hubBody ?? defaultBody, 'utf8');

  const lookup: NotebookLookup = {
    notebookId: 'nb-1',
    hubPath: hubPath as VaultFilePath,
    hubVaultPath,
    slug,
    topic: 'Demo',
  };

  return {
    vault,
    lookup,
    cleanup: () => {
      try {
        rmSync(vault, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

describe('appendAskAnswer', () => {
  it('writes a QA child note and replaces the placeholder under the hub Q&A section', async () => {
    const { vault, lookup, cleanup } = setupVault();
    try {
      const result = await appendAskAnswer({
        vaultBasePath: vault,
        lookup,
        question: 'What is the gist?',
        resolvedAnswer: 'It is a thing.',
        citedSources: [],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.qaVaultPath).toBe('reclaw/research/demo-topic/QA/What is the gist.md');
      expect(existsSync(result.value.qaAbsPath)).toBe(true);

      const qa = readFileSync(result.value.qaAbsPath, 'utf8');
      expect(qa).toContain('# What is the gist?');
      expect(qa).toContain('It is a thing.');
      expect(qa).toMatch(/^---\nquestion: 'What is the gist\?'/);

      const hub = readFileSync(lookup.hubPath, 'utf8');
      expect(hub).toContain('- [[What is the gist]]');
      expect(hub).not.toContain('_No questions answered._');
      // Section ordering is preserved.
      expect(hub.indexOf('## Sources')).toBeLessThan(hub.indexOf('## Questions & Answers'));
    } finally {
      cleanup();
    }
  });

  it('is idempotent: re-asking the same question does not duplicate the hub link', async () => {
    const { vault, lookup, cleanup } = setupVault();
    try {
      const args = {
        vaultBasePath: vault,
        lookup,
        question: 'Repeat?',
        resolvedAnswer: 'Yes.',
        citedSources: [] as readonly SourceMeta[],
      };

      const r1 = await appendAskAnswer(args);
      const r2 = await appendAskAnswer(args);

      expect(r1.ok && r1.value.hubUpdated).toBe(true);
      expect(r2.ok && r2.value.hubUpdated).toBe(false);

      const hub = readFileSync(lookup.hubPath, 'utf8');
      const occurrences = hub.split('- [[Repeat]]').length - 1;
      expect(occurrences).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('appends new questions after existing ones inside the Q&A section', async () => {
    const { vault, lookup, cleanup } = setupVault(
      [
        '---',
        "title: 'Demo'",
        '---',
        '',
        '## Questions & Answers',
        '',
        '- [[Existing question]]',
        '',
        '## Sources',
        '',
        '_No sources ingested._',
        '',
      ].join('\n'),
    );
    try {
      const res = await appendAskAnswer({
        vaultBasePath: vault,
        lookup,
        question: 'New one?',
        resolvedAnswer: 'sure',
        citedSources: [],
      });
      expect(res.ok).toBe(true);

      const hub = readFileSync(lookup.hubPath, 'utf8');
      const existingIdx = hub.indexOf('- [[Existing question]]');
      const newIdx = hub.indexOf('- [[New one]]');
      expect(existingIdx).toBeGreaterThan(0);
      expect(newIdx).toBeGreaterThan(existingIdx);
      // Sources heading is still after the Q&A section.
      expect(hub.indexOf('## Sources')).toBeGreaterThan(newIdx);
    } finally {
      cleanup();
    }
  });

  it('creates the section if the hub has no Questions & Answers heading', async () => {
    const { vault, lookup, cleanup } = setupVault(
      ['---', "title: 'Demo'", '---', '', '# Demo', '', 'Some prose.', ''].join('\n'),
    );
    try {
      const res = await appendAskAnswer({
        vaultBasePath: vault,
        lookup,
        question: 'Brand new?',
        resolvedAnswer: 'Yes.',
        citedSources: [],
      });

      expect(res.ok && res.value.hubUpdated).toBe(true);
      const hub = readFileSync(lookup.hubPath, 'utf8');
      expect(hub).toContain('## Questions & Answers');
      expect(hub).toContain('- [[Brand new]]');
    } finally {
      cleanup();
    }
  });

  it('embeds cited sources in the QA note body', async () => {
    const { vault, lookup, cleanup } = setupVault();
    const sources: readonly SourceMeta[] = [
      { id: 's1', title: 'Paper A', url: 'https://a', sourceType: 'web' },
      { id: 's2', title: 'Paper B', url: 'https://b', sourceType: 'pdf' },
    ];
    try {
      const res = await appendAskAnswer({
        vaultBasePath: vault,
        lookup,
        question: 'What did the papers say?',
        resolvedAnswer: 'They said things.',
        citedSources: sources,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const qa = readFileSync(res.value.qaAbsPath, 'utf8');
      expect(qa).toContain('- [[Paper A]]');
      expect(qa).toContain('- [[Paper B]]');
    } finally {
      cleanup();
    }
  });

  it('rejects a QA directory symlink that escapes the vault', async () => {
    const { vault, lookup, cleanup } = setupVault();
    const outside = mkdtempSync(join(tmpdir(), 'reclaw-qa-outside-'));
    const qaDir = join(vault, 'reclaw/research/demo-topic/QA');
    symlinkSync(outside, qaDir);
    try {
      const result = await appendAskAnswer({
        vaultBasePath: vault,
        lookup,
        question: 'Escape?',
        resolvedAnswer: 'No.',
        citedSources: [],
      });

      expect(result.ok).toBe(false);
      expect(existsSync(join(outside, 'Escape.md'))).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/escapes the configured root/i);
    } finally {
      cleanup();
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
