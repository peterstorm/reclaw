import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendPodcastLink } from './podcast-handler.js';

// ─── Test helpers ─────────────────────────────────────────────────────────────

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'podcast-handler-test-'));
}

async function writeNote(dir: string, content: string): Promise<string> {
  const filePath = path.join(dir, 'test-note.md');
  await fs.writeFile(filePath, content, 'utf-8');
  return filePath;
}

// ─── appendPodcastLink ───────────────────────────────────────────────────────

describe('appendPodcastLink', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-19T14:00:00Z'));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates a new Podcasts section when none exists', async () => {
    const filePath = await writeNote(tmpDir, '# My Note\n\nSome content.\n');

    await appendPodcastLink(filePath, 'Deep Dive', 'https://notebooklm.google.com/notebook/abc123');

    const result = await fs.readFile(filePath, 'utf-8');
    expect(result).toContain('## Podcasts');
    expect(result).toContain('- [Deep Dive — 2026-03-19](https://notebooklm.google.com/notebook/abc123)');
  });

  it('appends to existing Podcasts section', async () => {
    const existing = [
      '# My Note',
      '',
      'Content here.',
      '',
      '## Podcasts',
      '',
      '- [Brief — 2026-03-18](https://notebooklm.google.com/notebook/old)',
      '',
    ].join('\n');
    const filePath = await writeNote(tmpDir, existing);

    await appendPodcastLink(filePath, 'Deep Dive', 'https://notebooklm.google.com/notebook/new');

    const result = await fs.readFile(filePath, 'utf-8');
    // Both entries present
    expect(result).toContain('- [Brief — 2026-03-18](https://notebooklm.google.com/notebook/old)');
    expect(result).toContain('- [Deep Dive — 2026-03-19](https://notebooklm.google.com/notebook/new)');
    // Only one ## Podcasts heading
    expect(result.match(/## Podcasts/g)?.length).toBe(1);
  });

  it('handles file without trailing newline', async () => {
    const filePath = await writeNote(tmpDir, '# No Trailing Newline');

    await appendPodcastLink(filePath, 'Critique', 'https://example.com/podcast');

    const result = await fs.readFile(filePath, 'utf-8');
    expect(result).toContain('## Podcasts');
    expect(result).toContain('- [Critique — 2026-03-19](https://example.com/podcast)');
    // Should not have content jammed against heading
    expect(result).not.toContain('Newline## Podcasts');
  });

  it('preserves original note content', async () => {
    const original = '---\ntitle: Test\n---\n\n# Test Note\n\nImportant content here.\n';
    const filePath = await writeNote(tmpDir, original);

    await appendPodcastLink(filePath, 'Debate', 'https://example.com/debate');

    const result = await fs.readFile(filePath, 'utf-8');
    expect(result.startsWith('---\ntitle: Test\n---\n\n# Test Note\n\nImportant content here.\n')).toBe(true);
  });

  it('uses correct date from system time', async () => {
    vi.setSystemTime(new Date('2026-12-25T10:00:00Z'));

    const filePath = await writeNote(tmpDir, '# Christmas Note\n');

    await appendPodcastLink(filePath, 'Brief', 'https://example.com/xmas');

    const result = await fs.readFile(filePath, 'utf-8');
    expect(result).toContain('- [Brief — 2026-12-25](https://example.com/xmas)');
  });

  it('handles multiple appends correctly', async () => {
    const filePath = await writeNote(tmpDir, '# Multi Podcast Note\n');

    await appendPodcastLink(filePath, 'Deep Dive', 'https://example.com/1');
    vi.setSystemTime(new Date('2026-03-20T10:00:00Z'));
    await appendPodcastLink(filePath, 'Brief', 'https://example.com/2');
    vi.setSystemTime(new Date('2026-03-21T10:00:00Z'));
    await appendPodcastLink(filePath, 'Critique', 'https://example.com/3');

    const result = await fs.readFile(filePath, 'utf-8');
    expect(result.match(/## Podcasts/g)?.length).toBe(1);
    expect(result).toContain('- [Deep Dive — 2026-03-19](https://example.com/1)');
    expect(result).toContain('- [Brief — 2026-03-20](https://example.com/2)');
    expect(result).toContain('- [Critique — 2026-03-21](https://example.com/3)');
  });

  it('handles empty file', async () => {
    const filePath = await writeNote(tmpDir, '');

    await appendPodcastLink(filePath, 'Deep Dive', 'https://example.com/empty');

    const result = await fs.readFile(filePath, 'utf-8');
    expect(result).toContain('## Podcasts');
    expect(result).toContain('- [Deep Dive — 2026-03-19](https://example.com/empty)');
  });
});
