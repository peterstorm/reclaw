import { describe, expect, it } from 'vitest';
import { resolveBackend } from './index';
import { claudeBackend } from './claude-backend';
import { piBackend } from './pi-backend';

describe('resolveBackend', () => {
  it('returns claudeBackend for "claude"', () => {
    const backend = resolveBackend({ agentBackend: 'claude' });
    expect(backend).toBe(claudeBackend);
    expect(backend.name).toBe('claude');
  });

  it('returns piBackend for "pi"', () => {
    const backend = resolveBackend({ agentBackend: 'pi' });
    expect(backend).toBe(piBackend);
    expect(backend.name).toBe('pi');
  });

  it('throws for unknown backend values', () => {
    // @ts-expect-error - testing runtime safety for invalid values
    expect(() => resolveBackend({ agentBackend: 'invalid' })).toThrow('Unknown backend');
  });
});
