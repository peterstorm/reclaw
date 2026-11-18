import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type PodcastJob, err, makeJobId, makePodcastJob, ok } from '../core/types.js';
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

const makeJob = (notePath = 'test-note.md'): PodcastJob => {
  const id = makeJobId('podcast-test');
  if (!id.ok) throw new Error(id.error);
  const job = makePodcastJob({
    id: id.value,
    chatId: 42,
    notePath,
    audioFormat: 1,
    audioLength: 2,
    enqueuedAt: '2026-08-23T00:00:00.000Z',
  });
  if (!job.ok) throw new Error(job.error);
  return job.value;
};

type FakeNotebookLM = { readonly [K in keyof NotebookLMAdapter]?: ReturnType<typeof vi.fn> };

/** A NotebookLM fake whose podcast pipeline succeeds unless a step is overridden. */
const makeNotebookLM = (overrides: FakeNotebookLM = {}): NotebookLMAdapter =>
  ({
    createNotebook: vi.fn().mockResolvedValue(ok('notebook-1')),
    addSourceText: vi.fn().mockResolvedValue(ok('source-1')),
    waitForProcessing: vi.fn().mockResolvedValue(ok(undefined)),
    createAudioOverview: vi.fn().mockResolvedValue(ok('artifact-1')),
    waitForArtifact: vi.fn().mockResolvedValue(ok('ready')),
    shareNotebook: vi.fn().mockResolvedValue(ok('https://example.com/notebook-1')),
    ...overrides,
  }) as unknown as NotebookLMAdapter;

const failWith = (message: string) => vi.fn().mockResolvedValue(err({ message }));

type PipelineStep = Exclude<keyof NotebookLMAdapter, 'shareNotebook'>;

describe('handlePodcastJob', () => {
  let vault: string;
  let sendMessage: ReturnType<typeof vi.fn>;
  let telegram: TelegramAdapter;

  beforeEach(async () => {
    vault = await makeTempDir();
    sendMessage = vi.fn().mockResolvedValue(100);
    telegram = { sendMessage } as unknown as TelegramAdapter;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(vault, { recursive: true, force: true });
  });

  // Each row names the step and what it resolves to; the mock is built per test
  // because afterEach restores every mock.
  it.each<[PipelineStep, unknown, string, boolean]>([
    ['createNotebook', err({ message: 'quota' }), 'could not create notebook — quota', false],
    ['addSourceText', err({ message: 'too big' }), 'could not add note as source — too big', true],
    ['waitForProcessing', err({ message: 'stuck' }), 'source processing timed out — stuck', true],
    ['createAudioOverview', err({ message: 'rejected' }), 'audio creation failed — rejected', true],
    [
      'waitForArtifact',
      err({ message: '15m elapsed' }),
      'artifact generation timed out — 15m elapsed',
      true,
    ],
    ['waitForArtifact', ok('failed'), 'NotebookLM could not generate audio for "test note"', true],
  ])('fails the job when %s resolves %j', async (step, resolved, reason, notebookCreated) => {
    await writeNote(vault, '# Podcast source\n\nUseful content.\n');
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const notebookLM = makeNotebookLM({ [step]: vi.fn().mockResolvedValue(resolved) });

    const result = await handlePodcastJob(makeJob(), {
      notebookLM,
      telegram,
      vaultBasePath: vault,
    });

    expect(result).toEqual({ ok: false, error: `Podcast failed: ${reason}` });
    expect(sendMessage).toHaveBeenLastCalledWith(42, `Podcast failed: ${reason}`);
    expect(notebookLM.shareNotebook).not.toHaveBeenCalled();
    if (notebookCreated) {
      expect(logError).toHaveBeenCalledWith(expect.stringContaining('notebook notebook-1'));
    } else {
      expect(logError).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['the note is empty', '  \n', 'test-note.md', 'note is empty — "test-note.md"'],
    ['the note does not exist', '# Here', 'missing.md', 'note not found — "missing.md"'],
  ])('fails before NotebookLM when %s', async (_case, content, notePath, reason) => {
    await writeNote(vault, content);
    const notebookLM = makeNotebookLM();

    const result = await handlePodcastJob(makeJob(notePath), {
      notebookLM,
      telegram,
      vaultBasePath: vault,
    });

    expect(result).toEqual({ ok: false, error: `Podcast failed: ${reason}` });
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(42, `Podcast failed: ${reason}`);
    expect(notebookLM.createNotebook).not.toHaveBeenCalled();
  });

  it('fails before NotebookLM when the vault root cannot be opened', async () => {
    const notebookLM = makeNotebookLM();

    const result = await handlePodcastJob(makeJob(), {
      notebookLM,
      telegram,
      vaultBasePath: path.join(vault, 'no-such-vault'),
    });

    expect(result.ok).toBe(false);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(42, expect.stringMatching(/^Podcast failed: /));
    expect(notebookLM.createNotebook).not.toHaveBeenCalled();
  });

  it('falls back to the NotebookLM notebook URL when sharing fails', async () => {
    const notePath = await writeNote(vault, '# Podcast source\n\nUseful content.\n');
    const notebookLM = makeNotebookLM({ shareNotebook: failWith('forbidden') });

    const result = await handlePodcastJob(makeJob(), {
      notebookLM,
      telegram,
      vaultBasePath: vault,
    });

    const fallback = 'https://notebooklm.google.com/notebook/notebook-1';
    expect(result).toEqual({
      ok: true,
      response: `Podcast ready: test note\nFormat: Brief\n\n${fallback}`,
    });
    expect(sendMessage).toHaveBeenLastCalledWith(42, expect.stringContaining(fallback));
    expect(await fs.readFile(notePath, 'utf8')).toContain(`(${fallback})`);
  });

  it('succeeds with a warning when the link cannot be written back into the note', async () => {
    const notePath = await writeNote(vault, '# Podcast source\n\nUseful content.\n');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const notebookLM = makeNotebookLM({
      // The note disappears while the audio renders, so the link-back read fails.
      waitForArtifact: vi.fn().mockImplementation(async () => {
        await fs.rm(notePath);
        return ok('ready');
      }),
    });

    const result = await handlePodcastJob(makeJob(), {
      notebookLM,
      telegram,
      vaultBasePath: vault,
    });

    const ready =
      "Podcast ready: test note\nFormat: Brief\n\nhttps://example.com/notebook-1\n\n⚠️ Heads up: I couldn't add the podcast link back into the source note.";
    expect(result).toEqual({ ok: true, response: ready });
    expect(sendMessage).toHaveBeenLastCalledWith(42, ready);
  });

  it('rejects when the final share-link notification cannot be delivered', async () => {
    await writeNote(vault, '# Podcast source\n\nUseful content.\n');
    sendMessage.mockResolvedValueOnce(100).mockRejectedValueOnce(new Error('telegram unavailable'));

    await expect(
      handlePodcastJob(makeJob(), { notebookLM: makeNotebookLM(), telegram, vaultBasePath: vault }),
    ).rejects.toThrow('telegram unavailable');
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenLastCalledWith(
      42,
      expect.stringContaining('https://example.com/notebook-1'),
    );
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
