import { describe, expect, it } from 'vitest';
import { getPermissionFlags } from './permissions.js';

describe('getPermissionFlags', () => {
  it('includes --dangerously-skip-permissions for chat profile', () => {
    const flags = getPermissionFlags('chat');
    expect(flags).toContain('--dangerously-skip-permissions');
  });

  it('includes --dangerously-skip-permissions for scheduled profile', () => {
    const flags = getPermissionFlags('scheduled');
    expect(flags).toContain('--dangerously-skip-permissions');
  });

  it('includes --allowedTools flag for chat profile', () => {
    const flags = getPermissionFlags('chat');
    expect(flags).toContain('--allowedTools');
  });

  it('chat profile includes Read, Bash, recall, remember', () => {
    const flags = getPermissionFlags('chat');
    const toolsIdx = flags.indexOf('--allowedTools') + 1;
    const tools = flags[toolsIdx]?.split(',') ?? [];
    expect(tools).toContain('Read');
    expect(tools).toContain('Bash');
    expect(tools).toContain('recall');
    expect(tools).toContain('remember');
  });

  it('chat profile includes Write', () => {
    const flags = getPermissionFlags('chat');
    const toolsIdx = flags.indexOf('--allowedTools') + 1;
    const tools = flags[toolsIdx]?.split(',') ?? [];
    expect(tools).toContain('Write');
  });

  it('includes --allowedTools flag for scheduled profile', () => {
    const flags = getPermissionFlags('scheduled');
    expect(flags).toContain('--allowedTools');
  });

  it('scheduled profile includes Read, Write, Bash, recall, remember', () => {
    const flags = getPermissionFlags('scheduled');
    const toolsIdx = flags.indexOf('--allowedTools') + 1;
    const tools = flags[toolsIdx]?.split(',') ?? [];
    expect(tools).toContain('Read');
    expect(tools).toContain('Write');
    expect(tools).toContain('Bash');
    expect(tools).toContain('recall');
    expect(tools).toContain('remember');
  });

  it('returns exactly 3 flags (skip-permissions + flag name + tools value)', () => {
    expect(getPermissionFlags('chat').length).toBe(3);
    expect(getPermissionFlags('scheduled').length).toBe(3);
  });

  it('chat and scheduled profiles have the same tool sets', () => {
    const chatFlags = getPermissionFlags('chat');
    const scheduledFlags = getPermissionFlags('scheduled');
    const chatTools = chatFlags[chatFlags.indexOf('--allowedTools') + 1];
    const scheduledTools = scheduledFlags[scheduledFlags.indexOf('--allowedTools') + 1];
    expect(chatTools).toBe(scheduledTools);
  });
});
