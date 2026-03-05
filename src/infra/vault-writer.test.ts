// ─── Vault Writer Integration Tests ──────────────────────────────────────────
//
// Uses a real temp directory (not mocked fs) for integration testing.
// Tests: directory creation, file writing, hub path return, emergency fallback.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createVaultWriter } from './vault-writer.js';
import type { VaultNote } from '../core/vault-content.js';

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** Create a temp directory for a single test and return its path. */
async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'vault-writer-test-'));
}

/** Build a minimal VaultNote fixture. */
function makeNote(relativePath: string, content: string): VaultNote {
  return { relativePath, content };
}

/** Hub note fixture. */
function makeHubNote(topicSlug = 'ai-agents'): VaultNote {
  return makeNote(
    `reclaw/research/${topicSlug}/_index.md`,
    `---\ntitle: 'AI Agents'\ndate: 2026-03-04\nquality: good\n---\n\n# AI Agents\n`,
  );
}

/** Source note fixture. */
function makeSourceNote(topicSlug = 'ai-agents', title = 'My Source'): VaultNote {
  return makeNote(
    `reclaw/research/${topicSlug}/Sources/${title}.md`,
    `---\ntitle: '${title}'\nsource_type: web\nurl: 'https://example.com'\n---\n\n# ${title}\n`,
  );
}

/** Q&A note fixture. */
function makeQANote(topicSlug = 'ai-agents', question = 'What is an AI agent'): VaultNote {
  return makeNote(
    `reclaw/research/${topicSlug}/QA/${question}.md`,
    `---\nquestion: '${question}'\n---\n\n# ${question}\n\nAn AI agent is...\n`,
  );
}

/** Emergency note fixture. */
function makeEmergencyNote(topicSlug = 'ai-agents'): VaultNote {
  return makeNote(
    `reclaw/research/${topicSlug}/_emergency.md`,
    `---\ntitle: '[EMERGENCY] AI Agents'\nemergency: true\n---\n\n# [Emergency] AI Agents\n`,
  );
}

/** Read a file relative to basePath, returning null if missing. */
async function readFile(basePath: string, relativePath: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(basePath, relativePath), 'utf8');
  } catch {
    return null;
  }
}

/** Check whether a path exists. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('createVaultWriter', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    // Clean up temp dir after each test
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ─── writeNotes ─────────────────────────────────────────────────────────────

  describe('writeNotes', () => {
    it('writes hub note and returns its absolute path', async () => {
      const writer = createVaultWriter();
      const hubNote = makeHubNote();
      const result = await writer.writeNotes([hubNote], tmpDir);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('Expected ok');

      // Hub path should be absolute
      expect(path.isAbsolute(result.value)).toBe(true);
      expect(result.value).toContain('_index.md');

      // File should exist with correct content
      const content = await readFile(tmpDir, hubNote.relativePath);
      expect(content).not.toBeNull();
      expect(content).toContain('AI Agents');
    });

    it('creates nested directory structure for source notes', async () => {
      const writer = createVaultWriter();
      const notes: VaultNote[] = [makeHubNote(), makeSourceNote()];
      const result = await writer.writeNotes(notes, tmpDir);

      expect(result.ok).toBe(true);

      // Sources directory must exist
      const sourcesDir = path.join(tmpDir, 'reclaw/research/ai-agents/Sources');
      expect(await pathExists(sourcesDir)).toBe(true);

      // Source note must exist
      const content = await readFile(tmpDir, 'reclaw/research/ai-agents/Sources/My Source.md');
      expect(content).not.toBeNull();
      expect(content).toContain('My Source');
    });

    it('creates QA directory and writes Q&A notes', async () => {
      const writer = createVaultWriter();
      const notes: VaultNote[] = [makeHubNote(), makeQANote()];
      const result = await writer.writeNotes(notes, tmpDir);

      expect(result.ok).toBe(true);

      const qaDir = path.join(tmpDir, 'reclaw/research/ai-agents/QA');
      expect(await pathExists(qaDir)).toBe(true);

      const content = await readFile(tmpDir, 'reclaw/research/ai-agents/QA/What is an AI agent.md');
      expect(content).not.toBeNull();
      expect(content).toContain('What is an AI agent');
    });

    it('writes all note types (hub + sources + QA) in a single call', async () => {
      const writer = createVaultWriter();
      const notes: VaultNote[] = [
        makeHubNote(),
        makeSourceNote('ai-agents', 'Source One'),
        makeSourceNote('ai-agents', 'Source Two'),
        makeQANote('ai-agents', 'What are the key concepts'),
        makeQANote('ai-agents', 'How do agents learn'),
      ];

      const result = await writer.writeNotes(notes, tmpDir);
      expect(result.ok).toBe(true);

      // Verify all 5 files exist
      for (const note of notes) {
        const content = await readFile(tmpDir, note.relativePath);
        expect(content).not.toBeNull();
      }
    });

    it('is idempotent — writing same notes twice does not fail', async () => {
      const writer = createVaultWriter();
      const notes: VaultNote[] = [makeHubNote(), makeSourceNote()];

      const first = await writer.writeNotes(notes, tmpDir);
      expect(first.ok).toBe(true);

      // Write again — should overwrite, not fail
      const second = await writer.writeNotes(notes, tmpDir);
      expect(second.ok).toBe(true);
    });

    it('overwrites existing files with updated content on retry', async () => {
      const writer = createVaultWriter();
      const note = makeHubNote();

      await writer.writeNotes([note], tmpDir);

      // Update the content
      const updatedNote: VaultNote = { ...note, content: '# Updated Content\n' };
      await writer.writeNotes([updatedNote], tmpDir);

      const content = await readFile(tmpDir, note.relativePath);
      expect(content).toBe('# Updated Content\n');
    });

    it('returns error when notes array is empty', async () => {
      const writer = createVaultWriter();
      const result = await writer.writeNotes([], tmpDir);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('Expected error');
      expect(result.error).toContain('empty');
    });

    it('returns error when no hub note is present', async () => {
      const writer = createVaultWriter();
      const notes: VaultNote[] = [makeSourceNote()]; // no _index.md
      const result = await writer.writeNotes(notes, tmpDir);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('Expected error');
      expect(result.error).toContain('hub note');
    });

    it('handles deeply nested paths correctly', async () => {
      const writer = createVaultWriter();
      const deepNote = makeNote(
        'reclaw/research/deep-topic/Sources/Nested/Deep Title.md',
        '# Deep Title\n',
      );
      const hubNote = makeNote('reclaw/research/deep-topic/_index.md', '# Deep Topic\n');

      const result = await writer.writeNotes([hubNote, deepNote], tmpDir);
      expect(result.ok).toBe(true);

      const content = await readFile(tmpDir, deepNote.relativePath);
      expect(content).toBe('# Deep Title\n');
    });

    it('preserves UTF-8 content in written files', async () => {
      const writer = createVaultWriter();
      const content = '# Ünïcödë Tïtle\n\nSøme spëcïal chàractërs: 你好 🌍\n';
      const note = makeNote('reclaw/research/unicode-topic/_index.md', content);

      const result = await writer.writeNotes([note], tmpDir);
      expect(result.ok).toBe(true);

      const readContent = await readFile(tmpDir, note.relativePath);
      expect(readContent).toBe(content);
    });

    it('hub path returned is the absolute path including basePath', async () => {
      const writer = createVaultWriter();
      const hubNote = makeHubNote('my-topic');
      const result = await writer.writeNotes([hubNote], tmpDir);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('Expected ok');

      const expectedPath = path.join(tmpDir, 'reclaw/research/my-topic/_index.md');
      expect(result.value).toBe(expectedPath);
    });
  });

  // ─── writeEmergencyNote ──────────────────────────────────────────────────────

  describe('writeEmergencyNote', () => {
    it('writes emergency note and returns its absolute path', async () => {
      const writer = createVaultWriter();
      const note = makeEmergencyNote();
      const result = await writer.writeEmergencyNote(note, tmpDir);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('Expected ok');

      expect(path.isAbsolute(result.value)).toBe(true);
      expect(result.value).toContain('_emergency.md');

      const content = await readFile(tmpDir, note.relativePath);
      expect(content).not.toBeNull();
      expect(content).toContain('[EMERGENCY]');
    });

    it('creates parent directories for emergency note', async () => {
      const writer = createVaultWriter();
      const note = makeEmergencyNote('brand-new-topic');
      const result = await writer.writeEmergencyNote(note, tmpDir);

      expect(result.ok).toBe(true);

      const dir = path.join(tmpDir, 'reclaw/research/brand-new-topic');
      expect(await pathExists(dir)).toBe(true);
    });

    it('is idempotent — writing emergency note twice does not fail', async () => {
      const writer = createVaultWriter();
      const note = makeEmergencyNote();

      const first = await writer.writeEmergencyNote(note, tmpDir);
      expect(first.ok).toBe(true);

      const second = await writer.writeEmergencyNote(note, tmpDir);
      expect(second.ok).toBe(true);
    });

    it('returns the correct absolute path for emergency note', async () => {
      const writer = createVaultWriter();
      const note = makeEmergencyNote('test-slug');
      const result = await writer.writeEmergencyNote(note, tmpDir);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('Expected ok');

      const expectedPath = path.join(tmpDir, 'reclaw/research/test-slug/_emergency.md');
      expect(result.value).toBe(expectedPath);
    });

    it('returns err when basePath is an unwritable path (file not directory)', async () => {
      // Create a regular file so that mkdir(fileAsBasePath/...) fails
      const fileAsBasePath = path.join(tmpDir, 'notadir-emergency');
      await fs.writeFile(fileAsBasePath, 'blocking file', 'utf8');

      const writer = createVaultWriter();
      const note = makeEmergencyNote();
      const result = await writer.writeEmergencyNote(note, fileAsBasePath);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('Expected error');
      expect(result.error.length).toBeGreaterThan(0);
    });

    it('preserves full emergency note content', async () => {
      const writer = createVaultWriter();
      const content = `---
title: '[EMERGENCY] My Topic'
emergency: true
---

# Emergency Backup

## Raw Answers

### What is this?

An emergency answer here.

## Sources

- [Source 1](https://example.com) (web)
`;
      const note = makeNote('reclaw/research/my-topic/_emergency.md', content);
      const result = await writer.writeEmergencyNote(note, tmpDir);

      expect(result.ok).toBe(true);

      const readContent = await readFile(tmpDir, note.relativePath);
      expect(readContent).toBe(content);
    });
  });

  // ─── retry-exhaustion ────────────────────────────────────────────────────────

  describe('retry-exhaustion', () => {
    it('returns err when basePath is a file (mkdir fails on all retries)', async () => {
      // Create a regular file at tmpDir/notadir so that mkdir(notadir/...) fails
      const fileAsBasePath = path.join(tmpDir, 'notadir');
      await fs.writeFile(fileAsBasePath, 'I am a file, not a directory', 'utf8');

      const writer = createVaultWriter();
      // Hub note present so the guard passes; mkdir will fail because
      // fileAsBasePath is a regular file, not a directory.
      const notes: VaultNote[] = [makeHubNote()];
      const result = await writer.writeNotes(notes, fileAsBasePath);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('Expected error');
      expect(result.error.length).toBeGreaterThan(0);
    });
  });

  // ─── FR-052 fallback pattern ─────────────────────────────────────────────────

  describe('FR-052 emergency fallback pattern', () => {
    it('emergency note can be written even when basePath is otherwise empty', async () => {
      const writer = createVaultWriter();
      // Simulate scenario: structured write was never attempted, emergency note needed
      const emergencyNote = makeEmergencyNote('crash-topic');
      const result = await writer.writeEmergencyNote(emergencyNote, tmpDir);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('Expected ok');

      // The emergency note file must exist and be readable
      const content = await readFile(tmpDir, emergencyNote.relativePath);
      expect(content).not.toBeNull();
    });

    it('structured notes and emergency note can coexist in same basePath', async () => {
      const writer = createVaultWriter();
      // Scenario: partial structured writes succeeded, then emergency written
      const hubNote = makeHubNote('coexist-topic');
      await writer.writeNotes([hubNote], tmpDir);

      const emergencyNote = makeEmergencyNote('coexist-topic');
      const emergencyResult = await writer.writeEmergencyNote(emergencyNote, tmpDir);

      expect(emergencyResult.ok).toBe(true);

      // Both files must exist
      expect(await pathExists(path.join(tmpDir, 'reclaw/research/coexist-topic/_index.md'))).toBe(true);
      expect(await pathExists(path.join(tmpDir, 'reclaw/research/coexist-topic/_emergency.md'))).toBe(true);
    });
  });
});
