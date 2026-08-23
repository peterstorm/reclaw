import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TopicSlug, parseTopicSlugReference } from '../core/topic-slug.js';
import { findNotebookByTopic } from './research-vault-lookup.js';

function topicSlug(raw: string): TopicSlug {
  const parsed = parseTopicSlugReference(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

describe('findNotebookByTopic', () => {
  let vaultRoot: string;
  let outsideRoot: string;

  beforeAll(async () => {
    vaultRoot = await fs.mkdtemp(path.join(tmpdir(), 'reclaw-test-vault-'));
    outsideRoot = await fs.mkdtemp(path.join(tmpdir(), 'reclaw-test-outside-'));
    const topicDir = path.join(vaultRoot, 'reclaw', 'research', 'sample-topic');
    await fs.mkdir(topicDir, { recursive: true });
    await fs.writeFile(
      path.join(topicDir, '_index.md'),
      `---
title: 'Sample Topic'
date: 2026-05-10
quality: good
topic_slug: sample-topic
notebook_id: 'abc-123'
tags:
  - research
---

# Sample Topic
`,
      'utf8',
    );

    // Create a topic without notebook_id (legacy unbackfilled hub)
    const legacyDir = path.join(vaultRoot, 'reclaw', 'research', 'legacy-topic');
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(
      path.join(legacyDir, '_index.md'),
      `---
title: 'Legacy Topic'
date: 2026-01-01
topic_slug: legacy-topic
---

# Legacy Topic
`,
      'utf8',
    );
  });

  afterAll(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
    await fs.rm(outsideRoot, { recursive: true, force: true });
  });

  it('resolves a leaf slug to its notebook id and topic', async () => {
    const r = await findNotebookByTopic(vaultRoot, topicSlug('sample-topic'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.notebookId).toBe('abc-123');
      expect(r.value.slug).toBe('sample-topic');
      expect(r.value.topic).toBe('Sample Topic');
      expect(r.value.hubVaultPath).toBe('reclaw/research/sample-topic/_index.md');
    }
  });

  it('accepts a full vault path slug', async () => {
    const r = await findNotebookByTopic(vaultRoot, topicSlug('reclaw/research/sample-topic'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.notebookId).toBe('abc-123');
    }
  });

  it('errors with a friendly message when the hub note is missing', async () => {
    const r = await findNotebookByTopic(vaultRoot, topicSlug('no-such-topic'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/no research topic/i);
    }
  });

  it('errors when hub note has no notebook_id (needs backfill)', async () => {
    const r = await findNotebookByTopic(vaultRoot, topicSlug('legacy-topic'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/notebook_id/);
      expect(r.error).toMatch(/backfill/);
    }
  });

  it('rejects a topic directory symlink that escapes the vault root', async () => {
    const outsideTopic = path.join(outsideRoot, 'escaped-topic');
    await fs.mkdir(outsideTopic);
    await fs.writeFile(
      path.join(outsideTopic, '_index.md'),
      '---\ntitle: Escaped\nnotebook_id: outside\n---\n',
      'utf8',
    );
    await fs.symlink(outsideTopic, path.join(vaultRoot, 'reclaw', 'research', 'escaped-topic'));

    const result = await findNotebookByTopic(vaultRoot, topicSlug('escaped-topic'));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/escapes the configured root/i);
  });
});
