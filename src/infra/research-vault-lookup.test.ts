import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { findNotebookByTopic, normalizeTopicSlug } from './research-vault-lookup.js';

describe('normalizeTopicSlug', () => {
  it('returns leaf slugs unchanged', () => {
    expect(normalizeTopicSlug('my-topic')).toBe('my-topic');
  });

  it('strips reclaw/research/ prefix', () => {
    expect(normalizeTopicSlug('reclaw/research/my-topic')).toBe('my-topic');
  });

  it('strips trailing /_index and /_index.md', () => {
    expect(normalizeTopicSlug('reclaw/research/my-topic/_index')).toBe('my-topic');
    expect(normalizeTopicSlug('my-topic/_index.md')).toBe('my-topic');
  });

  it('handles backslashes (Telegram autocorrect)', () => {
    expect(normalizeTopicSlug('reclaw\\research\\my-topic')).toBe('my-topic');
  });
});

describe('findNotebookByTopic', () => {
  let vaultRoot: string;

  beforeAll(async () => {
    vaultRoot = await fs.mkdtemp(path.join(tmpdir(), 'reclaw-test-vault-'));
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
  });

  it('resolves a leaf slug to its notebook id and topic', async () => {
    const r = await findNotebookByTopic(vaultRoot, 'sample-topic');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.notebookId).toBe('abc-123');
      expect(r.value.slug).toBe('sample-topic');
      expect(r.value.topic).toBe('Sample Topic');
      expect(r.value.hubVaultPath).toBe('reclaw/research/sample-topic/_index.md');
    }
  });

  it('accepts a full vault path slug', async () => {
    const r = await findNotebookByTopic(vaultRoot, 'reclaw/research/sample-topic');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.notebookId).toBe('abc-123');
    }
  });

  it('errors with a friendly message when the hub note is missing', async () => {
    const r = await findNotebookByTopic(vaultRoot, 'no-such-topic');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/no research topic/i);
    }
  });

  it('errors when hub note has no notebook_id (needs backfill)', async () => {
    const r = await findNotebookByTopic(vaultRoot, 'legacy-topic');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/notebook_id/);
      expect(r.error).toMatch(/backfill/);
    }
  });
});
