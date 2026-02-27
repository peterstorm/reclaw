import { describe, it, expect } from 'vitest';
import { mangleCwd, deriveTranscriptPath } from './cortex-extract.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
    expect(mangleCwd('/home/peterstorm/dev/claude-plugins/reclaw/workspace'))
      .toBe('-home-peterstorm-dev-claude-plugins-reclaw-workspace');
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
