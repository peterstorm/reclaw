import { describe, expect, it } from 'vitest';
import { parsePodcastCommand } from './podcast-request.js';

describe('parsePodcastCommand', () => {
  it('parses a vault path and defaults', () => {
    expect(parsePodcastCommand('/podcast concepts/agent-systems')).toEqual({
      ok: true,
      value: {
        notePath: 'concepts/agent-systems',
        format: 'deep-dive',
        length: 'long',
      },
    });
  });

  it('parses format and length without including flags in the path', () => {
    expect(
      parsePodcastCommand('/podcast concepts/my note --format critique --length short'),
    ).toEqual({
      ok: true,
      value: {
        notePath: 'concepts/my note',
        format: 'critique',
        length: 'short',
      },
    });
  });

  it('normalizes backslashes in a valid copied path', () => {
    const result = parsePodcastCommand('/podcast concepts\\nested\\note.md');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.notePath).toBe('concepts/nested/note.md');
  });

  it.each([
    '/podcast ../outside',
    '/podcast folder/../../outside',
    '/podcast /etc/passwd',
    '/podcast C:\\Users\\person\\secret',
    '/podcast folder\\..\\outside',
    '/podcast folder/%2e%2e/outside',
  ])('rejects unsafe vault path: %s', (command) => {
    const result = parsePodcastCommand(command);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/invalid vault path/i);
  });
});
