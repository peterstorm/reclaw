import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  derivePiTranscriptDirectory,
  deriveTranscriptPath,
  mangleCwd,
  manglePiCwd,
  matchPiTranscriptFilename,
  resolveTranscriptPath,
} from './cortex-extract.js';

const originalPiSessionDirectory = process.env.PI_CODING_AGENT_SESSION_DIR;

afterEach(() => {
  if (originalPiSessionDirectory === undefined) {
    process.env.PI_CODING_AGENT_SESSION_DIR = undefined;
  } else {
    process.env.PI_CODING_AGENT_SESSION_DIR = originalPiSessionDirectory;
  }
});

describe('mangleCwd', () => {
  it('replaces slashes with dashes', () => {
    expect(mangleCwd('/home/user/project')).toBe('-home-user-project');
  });

  it('replaces dots with dashes', () => {
    expect(mangleCwd('/home/user/.dotfiles')).toBe('-home-user--dotfiles');
  });

  it('preserves existing dashes', () => {
    expect(mangleCwd('/home/user/claude-plugins')).toBe('-home-user-claude-plugins');
  });

  it('handles deeply nested paths', () => {
    expect(mangleCwd('/home/peterstorm/dev/claude-plugins/reclaw/workspace')).toBe(
      '-home-peterstorm-dev-claude-plugins-reclaw-workspace',
    );
  });

  it('handles paths with dots in directory names', () => {
    expect(mangleCwd('/home/user/.config/app.d')).toBe('-home-user--config-app-d');
  });
});

describe('deriveTranscriptPath', () => {
  it('constructs the correct JSONL path', () => {
    const result = deriveTranscriptPath('abc-123', '/home/user/project');
    const expected = join(homedir(), '.claude', 'projects', '-home-user-project', 'abc-123.jsonl');
    expect(result).toBe(expected);
  });

  it('uses the mangled cwd as the project directory', () => {
    const result = deriveTranscriptPath(
      'sess-456',
      '/home/peterstorm/dev/claude-plugins/reclaw/workspace',
    );
    expect(result).toContain('-home-peterstorm-dev-claude-plugins-reclaw-workspace');
    expect(result).toContain('sess-456.jsonl');
  });
});

describe('Pi transcript location', () => {
  it('encodes the cwd using Pi session-directory rules', () => {
    expect(manglePiCwd('/home/user/.config:preview')).toBe('--home-user-.config-preview--');
  });

  it('derives the default encoded session directory', () => {
    expect(derivePiTranscriptDirectory('/home/user/project', undefined)).toBe(
      join(homedir(), '.pi', 'agent', 'sessions', '--home-user-project--'),
    );
  });

  it('honors Pi custom session-directory configuration', () => {
    expect(derivePiTranscriptDirectory('/ignored', '/custom/pi-sessions')).toBe(
      '/custom/pi-sessions',
    );
  });

  it('matches only the exact timestamp-prefixed session filename', () => {
    expect(
      matchPiTranscriptFilename('session-123', [
        '2026-08-21T03-30-00Z_session-12.jsonl',
        '2026-08-21T03-40-00Z_session-123.jsonl',
        'session-123.jsonl',
      ]),
    ).toEqual({
      kind: 'found',
      filename: '2026-08-21T03-40-00Z_session-123.jsonl',
    });
  });

  it('distinguishes missing and ambiguous matches', () => {
    expect(matchPiTranscriptFilename('missing', ['other.jsonl'])).toEqual({ kind: 'missing' });
    expect(
      matchPiTranscriptFilename('duplicate', [
        '2026-08-20_duplicate.jsonl',
        '2026-08-21_duplicate.jsonl',
      ]),
    ).toEqual({
      kind: 'ambiguous',
      filenames: ['2026-08-20_duplicate.jsonl', '2026-08-21_duplicate.jsonl'],
    });
  });

  it('returns missing only when the Pi session directory does not exist', () => {
    process.env.PI_CODING_AGENT_SESSION_DIR = join(tmpdir(), crypto.randomUUID(), 'missing');
    expect(
      resolveTranscriptPath(`missing-${crypto.randomUUID()}`, '/no/claude/project'),
    ).toBeNull();
  });

  it('propagates Pi session lookup failures so durable extraction can retry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'reclaw-pi-transcripts-'));
    const notDirectory = join(directory, 'not-a-directory');
    await writeFile(notDirectory, 'content');
    process.env.PI_CODING_AGENT_SESSION_DIR = notDirectory;
    try {
      expect(() =>
        resolveTranscriptPath(`unreadable-${crypto.randomUUID()}`, '/no/claude/project'),
      ).toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
