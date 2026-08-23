import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeJobId, makePodcastJob, ok } from '../core/types.js';
import type { NotebookLMAdapter } from '../infra/notebooklm-client.js';
import type { TelegramAdapter } from '../infra/telegram.js';
import { appendPodcastLink, handlePodcastJob } from './podcast-handler.js';

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

describe('handlePodcastJob', () => {
  it('rejects when the final share-link notification cannot be delivered', async () => {
    const vault = await makeTempDir();
    await writeNote(vault, '# Podcast source\n\nUseful content.\n');
    const id = makeJobId('podcast-test');
    if (!id.ok) throw new Error(id.error);
    const job = makePodcastJob({
      id: id.value,
      chatId: 42,
      notePath: 'test-note.md',
      audioFormat: 1,
      audioLength: 2,
      enqueuedAt: '2026-08-23T00:00:00.000Z',
    });
    if (!job.ok) throw new Error(job.error);

    const notebookLM = {
      createNotebook: vi.fn().mockResolvedValue(ok('notebook-1')),
      addSourceText: vi.fn().mockResolvedValue(ok('source-1')),
      waitForProcessing: vi.fn().mockResolvedValue(ok(undefined)),
      createAudioOverview: vi.fn().mockResolvedValue(ok('artifact-1')),
      waitForArtifact: vi.fn().mockResolvedValue(ok('ready')),
      shareNotebook: vi.fn().mockResolvedValue(ok('https://example.com/notebook-1')),
    } as unknown as NotebookLMAdapter;
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce(100)
      .mockRejectedValueOnce(new Error('telegram unavailable'));
    const telegram = { sendMessage } as unknown as TelegramAdapter;

    try {
      await expect(
        handlePodcastJob(job.value, { notebookLM, telegram, vaultBasePath: vault }),
      ).rejects.toThrow('telegram unavailable');
      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(sendMessage).toHaveBeenLastCalledWith(
        42,
        expect.stringContaining('https://example.com/notebook-1'),
      );
    } finally {
      await fs.rm(vault, { recursive: true, force: true });
    }
  });
});

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

    await appendPodcastLink(
      tmpDir,
      'test-note.md',
      'Deep Dive',
      'https://notebooklm.google.com/notebook/abc123',
    );

    const result = await fs.readFile(filePath, 'utf-8');
    expect(result).toContain('## Podcasts');
    expect(result).toContain(
      '- [Deep Dive — 2026-03-19](https://notebooklm.google.com/notebook/abc123)',
    );
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

    await appendPodcastLink(
      tmpDir,
      'test-note.md',
      'Deep Dive',
      'https://notebooklm.google.com/notebook/new',
    );

    const result = await fs.readFile(filePath, 'utf-8');
    // Both entries present
    expect(result).toContain('- [Brief — 2026-03-18](https://notebooklm.google.com/notebook/old)');
    expect(result).toContain(
      '- [Deep Dive — 2026-03-19](https://notebooklm.google.com/notebook/new)',
    );
    // Only one ## Podcasts heading
    expect(result.match(/## Podcasts/g)?.length).toBe(1);
  });

  it('handles file without trailing newline', async () => {
    const filePath = await writeNote(tmpDir, '# No Trailing Newline');

    await appendPodcastLink(tmpDir, 'test-note.md', 'Critique', 'https://example.com/podcast');

    const result = await fs.readFile(filePath, 'utf-8');
    expect(result).toContain('## Podcasts');
    expect(result).toContain('- [Critique — 2026-03-19](https://example.com/podcast)');
    // Should not have content jammed against heading
    expect(result).not.toContain('Newline## Podcasts');
  });

  it('preserves original note content', async () => {
    const original = '---\ntitle: Test\n---\n\n# Test Note\n\nImportant content here.\n';
    const filePath = await writeNote(tmpDir, original);

    await appendPodcastLink(tmpDir, 'test-note.md', 'Debate', 'https://example.com/debate');

    const result = await fs.readFile(filePath, 'utf-8');
    expect(
      result.startsWith('---\ntitle: Test\n---\n\n# Test Note\n\nImportant content here.\n'),
    ).toBe(true);
  });

  it('uses correct date from system time', async () => {
    vi.setSystemTime(new Date('2026-12-25T10:00:00Z'));

    const filePath = await writeNote(tmpDir, '# Christmas Note\n');

    await appendPodcastLink(tmpDir, 'test-note.md', 'Brief', 'https://example.com/xmas');

    const result = await fs.readFile(filePath, 'utf-8');
    expect(result).toContain('- [Brief — 2026-12-25](https://example.com/xmas)');
  });

  it('handles multiple appends correctly', async () => {
    const filePath = await writeNote(tmpDir, '# Multi Podcast Note\n');

    await appendPodcastLink(tmpDir, 'test-note.md', 'Deep Dive', 'https://example.com/1');
    vi.setSystemTime(new Date('2026-03-20T10:00:00Z'));
    await appendPodcastLink(tmpDir, 'test-note.md', 'Brief', 'https://example.com/2');
    vi.setSystemTime(new Date('2026-03-21T10:00:00Z'));
    await appendPodcastLink(tmpDir, 'test-note.md', 'Critique', 'https://example.com/3');

    const result = await fs.readFile(filePath, 'utf-8');
    expect(result.match(/## Podcasts/g)?.length).toBe(1);
    expect(result).toContain('- [Deep Dive — 2026-03-19](https://example.com/1)');
    expect(result).toContain('- [Brief — 2026-03-20](https://example.com/2)');
    expect(result).toContain('- [Critique — 2026-03-21](https://example.com/3)');
  });

  it('handles empty file', async () => {
    const filePath = await writeNote(tmpDir, '');

    await appendPodcastLink(tmpDir, 'test-note.md', 'Deep Dive', 'https://example.com/empty');

    const result = await fs.readFile(filePath, 'utf-8');
    expect(result).toContain('## Podcasts');
    expect(result).toContain('- [Deep Dive — 2026-03-19](https://example.com/empty)');
  });

  it('rejects traversal before reading or writing a note', async () => {
    await expect(
      appendPodcastLink(tmpDir, '../outside.md', 'Deep Dive', 'https://example.com/escape'),
    ).rejects.toThrow(/must not contain.*\.\./i);
  });

  it('rejects a note symlink that escapes the vault', async () => {
    const outsideDir = await makeTempDir();
    const outsideFile = await writeNote(outsideDir, '# Outside\n');
    await fs.symlink(outsideFile, path.join(tmpDir, 'linked.md'));
    try {
      await expect(
        appendPodcastLink(tmpDir, 'linked.md', 'Deep Dive', 'https://example.com/escape'),
      ).rejects.toThrow(/escapes the configured root/i);
      expect(await fs.readFile(outsideFile, 'utf8')).toBe('# Outside\n');
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});
