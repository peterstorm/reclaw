import { describe, expect, it } from 'vitest';
import { formatAgentFailure } from '../core/agent-failure.js';
import { formatDeadLetterMessage } from './worker.js';

describe('formatDeadLetterMessage — spent usage window', () => {
  const quotaMessage = formatAgentFailure({
    kind: 'provider-quota-exhausted',
    backend: 'claude',
    detail: "You've hit your session limit · resets 2:50pm (Europe/Copenhagen)",
  });

  it('tells a chat user when the backend resets instead of "try again"', () => {
    const msg = formatDeadLetterMessage('chat', 'job-1', quotaMessage);
    expect(msg).toContain('claude is out of usage');
    expect(msg).toContain('resets 2:50pm');
    expect(msg).toContain('/new');
    expect(msg).not.toContain('Please try again');
    expect(msg).not.toContain('job-1');
  });

  it('keeps the generic chat message for every other failure', () => {
    const other = formatAgentFailure({
      kind: 'provider-unavailable',
      backend: 'pi',
      detail: 'Connection error.',
    });
    expect(formatDeadLetterMessage('chat', 'job-2', other)).toBe(
      'Sorry, I ran into a problem processing your message. Please try again.',
    );
  });

  it('leaves operator-facing (non-chat) dead letters unchanged', () => {
    expect(formatDeadLetterMessage('scheduled', 'job-3', quotaMessage)).toContain(
      'permanently failed',
    );
  });
});
