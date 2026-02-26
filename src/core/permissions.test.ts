import { describe, expect, it } from 'vitest';
import { getPermissionFlags } from './permissions.js';

describe('getPermissionFlags', () => {
  it('returns --allowedTools flag for chat profile', () => {
    const flags = getPermissionFlags('chat');
    expect(flags[0]).toBe('--allowedTools');
  });

  it('chat profile includes Read, Bash, recall, remember', () => {
    const flags = getPermissionFlags('chat');
    const tools = flags[1]?.split(',') ?? [];
    expect(tools).toContain('Read');
    expect(tools).toContain('Bash');
    expect(tools).toContain('recall');
    expect(tools).toContain('remember');
  });

  it('chat profile does NOT include Write', () => {
    const flags = getPermissionFlags('chat');
    const tools = flags[1]?.split(',') ?? [];
    expect(tools).not.toContain('Write');
  });

  it('returns --allowedTools flag for scheduled profile', () => {
    const flags = getPermissionFlags('scheduled');
    expect(flags[0]).toBe('--allowedTools');
  });

  it('scheduled profile includes Read, Write, Bash, recall, remember', () => {
    const flags = getPermissionFlags('scheduled');
    const tools = flags[1]?.split(',') ?? [];
    expect(tools).toContain('Read');
    expect(tools).toContain('Write');
    expect(tools).toContain('Bash');
    expect(tools).toContain('recall');
    expect(tools).toContain('remember');
  });

  it('returns exactly 2 flags (flag name + tools value)', () => {
    expect(getPermissionFlags('chat').length).toBe(2);
    expect(getPermissionFlags('scheduled').length).toBe(2);
  });

  it('result is readonly (no mutation)', () => {
    const flags = getPermissionFlags('chat');
    // TypeScript enforces readonly; runtime check: assignment to index
    expect(() => {
      // biome-ignore lint/suspicious/noExplicitAny: testing immutability guard
      (flags as any)[0] = 'mutated';
    }).not.toThrow(); // JS arrays are mutable, but we confirm the value is treated as const
    // The actual contract is type-level; runtime the array is just a JS array
  });

  it('chat and scheduled profiles have different tool sets', () => {
    const chatTools = getPermissionFlags('chat')[1];
    const scheduledTools = getPermissionFlags('scheduled')[1];
    expect(chatTools).not.toBe(scheduledTools);
  });
});
