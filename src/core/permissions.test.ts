import { describe, expect, it } from 'vitest';
import { getAllowedTools } from './permissions.js';

describe('getAllowedTools', () => {
  it('chat profile returns expected tool names', () => {
    const tools = getAllowedTools('chat');
    expect(tools).toEqual(['Read', 'Write', 'Bash', 'recall', 'remember']);
  });

  it('scheduled profile returns expected tool names', () => {
    const tools = getAllowedTools('scheduled');
    expect(tools).toEqual(['Read', 'Write', 'Bash', 'recall', 'remember']);
  });

  it('returns individual tool names, not formatted CLI flags', () => {
    const tools = getAllowedTools('chat');
    for (const tool of tools) {
      expect(tool).not.toMatch(/^--/);
    }
  });

  it('does not contain comma-separated strings (each tool is a separate element)', () => {
    const tools = getAllowedTools('chat');
    for (const tool of tools) {
      expect(tool).not.toContain(',');
    }
  });

  it('returns a readonly array of 5 tool names', () => {
    expect(getAllowedTools('chat').length).toBe(5);
    expect(getAllowedTools('scheduled').length).toBe(5);
  });

  it('chat and scheduled profiles have the same tool sets', () => {
    expect(getAllowedTools('chat')).toEqual(getAllowedTools('scheduled'));
  });
});
