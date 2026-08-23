import { describe, expect, it } from 'vitest';
import { getAllowedTools } from './permissions.js';

const EXPECTED_CHAT_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Glob',
  'Grep',
  'Find',
  'Ls',
  'WebSearch',
  'WebFetch',
  'Task',
  'Skill',
  'TodoWrite',
  'NotebookEdit',
  'subagent',
  'recall',
  'remember',
  'forget',
] as const;

const EXPECTED_SCHEDULED_TOOLS = [
  'Read',
  'Write',
  'Bash',
  'WebSearch',
  'WebFetch',
  'recall',
  'remember',
  'forget',
] as const;

describe('getAllowedTools', () => {
  it('gives interactive chat the complete personal-agent capability profile', () => {
    expect(getAllowedTools('chat')).toEqual(EXPECTED_CHAT_TOOLS);
  });

  it('keeps unattended scheduled execution on the constrained profile', () => {
    expect(getAllowedTools('scheduled')).toEqual(EXPECTED_SCHEDULED_TOOLS);
  });

  it('includes web tools needed by scheduled search and fetch skills', () => {
    const tools = getAllowedTools('scheduled');
    expect(tools).toContain('WebSearch');
    expect(tools).toContain('WebFetch');
  });

  it('grants interactive chat native editing, skills, and backend-specific delegation', () => {
    const tools = getAllowedTools('chat');
    expect(tools).toEqual(
      expect.arrayContaining(['Edit', 'Glob', 'Grep', 'Task', 'Skill', 'subagent']),
    );
  });

  it('does not grant unattended jobs interactive delegation or skill-loading tools', () => {
    const tools = getAllowedTools('scheduled');
    expect(tools).not.toContain('Task');
    expect(tools).not.toContain('Skill');
    expect(tools).not.toContain('subagent');
  });

  it('makes scheduled capabilities a strict subset of chat capabilities', () => {
    const chat = new Set(getAllowedTools('chat'));
    const scheduled = getAllowedTools('scheduled');

    expect(scheduled.every((tool) => chat.has(tool))).toBe(true);
    expect(chat.size).toBeGreaterThan(scheduled.length);
  });

  it.each(['chat', 'scheduled'] as const)(
    '%s contains unique, unformatted semantic names',
    (profile) => {
      const tools = getAllowedTools(profile);

      expect(new Set(tools).size).toBe(tools.length);
      for (const tool of tools) {
        expect(tool).not.toMatch(/^--/);
        expect(tool).not.toContain(',');
      }
    },
  );
});
