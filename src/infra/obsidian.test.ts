import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createObsidianAdapter } from './obsidian.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string;

async function mkNote(vaultDir: string, rel: string, content: string): Promise<void> {
  const full = path.join(vaultDir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf-8');
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ─── readNote ─────────────────────────────────────────────────────────────────

describe('readNote', () => {
  it('returns parsed note with frontmatter and content', async () => {
    const raw = `---\ntitle: Hello\ntags: [a, b]\n---\n\nBody text here.`;
    await mkNote(tmpDir, 'notes/hello.md', raw);

    const adapter = createObsidianAdapter(tmpDir);
    const note = await adapter.readNote('notes/hello.md');

    expect(note).not.toBeNull();
    expect(note!.path).toBe('notes/hello.md');
    expect(note!.frontmatter['title']).toBe('Hello');
    expect(note!.frontmatter['tags']).toEqual(['a', 'b']);
    expect(note!.content.trim()).toBe('Body text here.');
  });

  it('returns null for non-existent file', async () => {
    const adapter = createObsidianAdapter(tmpDir);
    const note = await adapter.readNote('does-not-exist.md');
    expect(note).toBeNull();
  });

  it('returns null for path traversal attempt', async () => {
    const adapter = createObsidianAdapter(tmpDir);
    const note = await adapter.readNote('../etc/passwd');
    expect(note).toBeNull();
  });

  it('returns note with empty frontmatter when no frontmatter present', async () => {
    await mkNote(tmpDir, 'plain.md', 'Just plain content.');
    const adapter = createObsidianAdapter(tmpDir);
    const note = await adapter.readNote('plain.md');
    expect(note).not.toBeNull();
    expect(note!.frontmatter).toEqual({});
    expect(note!.content.trim()).toBe('Just plain content.');
  });
});

// ─── writeNote ────────────────────────────────────────────────────────────────

describe('writeNote', () => {
  it('creates file with correct frontmatter format', async () => {
    const adapter = createObsidianAdapter(tmpDir);
    await adapter.writeNote('note.md', { title: 'Test', tags: ['x'] }, 'Content here.');

    const raw = await fs.readFile(path.join(tmpDir, 'note.md'), 'utf-8');
    expect(raw).toContain('title: Test');
    expect(raw).toContain('Content here.');
    expect(raw).toMatch(/^---/);
  });

  it('creates parent directories when they do not exist', async () => {
    const adapter = createObsidianAdapter(tmpDir);
    await adapter.writeNote('deep/nested/dir/note.md', { title: 'Deep' }, 'Deep content.');

    const full = path.join(tmpDir, 'deep/nested/dir/note.md');
    const stat = await fs.stat(full);
    expect(stat.isFile()).toBe(true);
  });

  it('throws on path traversal attempt', async () => {
    const adapter = createObsidianAdapter(tmpDir);
    await expect(
      adapter.writeNote('../outside.md', {}, 'content'),
    ).rejects.toThrow(/traversal/i);
  });

  it('overwrites existing file', async () => {
    await mkNote(tmpDir, 'overwrite.md', '---\ntitle: Old\n---\nOld content.');
    const adapter = createObsidianAdapter(tmpDir);
    await adapter.writeNote('overwrite.md', { title: 'New' }, 'New content.');

    const note = await adapter.readNote('overwrite.md');
    expect(note!.frontmatter['title']).toBe('New');
    expect(note!.content.trim()).toBe('New content.');
  });
});

// ─── listNotes ────────────────────────────────────────────────────────────────

describe('listNotes', () => {
  it('returns all .md files recursively', async () => {
    await mkNote(tmpDir, 'a.md', '');
    await mkNote(tmpDir, 'sub/b.md', '');
    await mkNote(tmpDir, 'sub/deep/c.md', '');
    await mkNote(tmpDir, 'sub/ignore.txt', ''); // not .md

    const adapter = createObsidianAdapter(tmpDir);
    const notes = await adapter.listNotes();

    expect(notes).toHaveLength(3);
    expect(notes).toContain('a.md');
    expect(notes).toContain(path.join('sub', 'b.md'));
    expect(notes).toContain(path.join('sub', 'deep', 'c.md'));
  });

  it('filters to subfolder when folder arg given', async () => {
    await mkNote(tmpDir, 'root.md', '');
    await mkNote(tmpDir, 'journal/2024-01.md', '');
    await mkNote(tmpDir, 'journal/2024-02.md', '');

    const adapter = createObsidianAdapter(tmpDir);
    const notes = await adapter.listNotes('journal');

    expect(notes).toHaveLength(2);
    for (const n of notes) {
      expect(n.startsWith('journal')).toBe(true);
    }
  });

  it('returns empty array when vault directory does not exist', async () => {
    const adapter = createObsidianAdapter('/nonexistent/path/that/does/not/exist');
    const notes = await adapter.listNotes();
    expect(notes).toEqual([]);
  });

  it('returns empty array when subfolder does not exist', async () => {
    const adapter = createObsidianAdapter(tmpDir);
    const notes = await adapter.listNotes('no-such-folder');
    expect(notes).toEqual([]);
  });

  it('returns empty array for path traversal subfolder', async () => {
    const adapter = createObsidianAdapter(tmpDir);
    const notes = await adapter.listNotes('../outside');
    expect(notes).toEqual([]);
  });
});

// ─── searchNotes ──────────────────────────────────────────────────────────────

describe('searchNotes', () => {
  it('finds notes matching query in content', async () => {
    await mkNote(tmpDir, 'match.md', '---\ntitle: A\n---\nThis has the keyword secret here.');
    await mkNote(tmpDir, 'nomatch.md', '---\ntitle: B\n---\nNothing relevant.');

    const adapter = createObsidianAdapter(tmpDir);
    const results = await adapter.searchNotes('secret');

    expect(results).toHaveLength(1);
    expect(results[0]!.path).toBe('match.md');
  });

  it('finds notes matching query in frontmatter', async () => {
    await mkNote(tmpDir, 'fm.md', '---\ntopic: important-keyword\n---\nRegular body.');
    await mkNote(tmpDir, 'other.md', '---\ntopic: nothing\n---\nBody.');

    const adapter = createObsidianAdapter(tmpDir);
    const results = await adapter.searchNotes('important-keyword');

    expect(results).toHaveLength(1);
    expect(results[0]!.path).toBe('fm.md');
  });

  it('is case-insensitive', async () => {
    await mkNote(tmpDir, 'case.md', '---\ntitle: Hello\n---\nWorld content.');

    const adapter = createObsidianAdapter(tmpDir);
    const byUpper = await adapter.searchNotes('HELLO');
    const byLower = await adapter.searchNotes('world');

    expect(byUpper).toHaveLength(1);
    expect(byLower).toHaveLength(1);
  });

  it('returns empty array when no notes match', async () => {
    await mkNote(tmpDir, 'note.md', '---\ntitle: Nothing\n---\nContent.');

    const adapter = createObsidianAdapter(tmpDir);
    const results = await adapter.searchNotes('zzznomatch');

    expect(results).toHaveLength(0);
  });

  it('returns empty array for empty vault', async () => {
    const adapter = createObsidianAdapter('/nonexistent');
    const results = await adapter.searchNotes('anything');
    expect(results).toHaveLength(0);
  });
});

// ─── Roundtrip ────────────────────────────────────────────────────────────────

describe('roundtrip', () => {
  it('write then read back preserves frontmatter and content', async () => {
    const adapter = createObsidianAdapter(tmpDir);
    const fm = { title: 'Roundtrip', date: '2024-01-01', count: 42 };
    const body = 'This is the note body.\n\nWith multiple paragraphs.';

    await adapter.writeNote('roundtrip.md', fm, body);
    const note = await adapter.readNote('roundtrip.md');

    expect(note).not.toBeNull();
    expect(note!.frontmatter['title']).toBe('Roundtrip');
    expect(note!.frontmatter['date']).toBe('2024-01-01');
    expect(note!.frontmatter['count']).toBe(42);
    expect(note!.content.trim()).toBe(body.trim());
  });

  it('write to subdirectory then list and read back', async () => {
    const adapter = createObsidianAdapter(tmpDir);
    await adapter.writeNote('projects/myproject/notes.md', { project: 'myproject' }, 'Notes.');

    const listed = await adapter.listNotes('projects');
    expect(listed).toHaveLength(1);
    expect(listed[0]).toContain('notes.md');

    const note = await adapter.readNote(listed[0]!);
    expect(note).not.toBeNull();
    expect(note!.frontmatter['project']).toBe('myproject');
    expect(note!.content.trim()).toBe('Notes.');
  });
});
