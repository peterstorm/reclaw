import { describe, expect, it } from 'vitest';
import { type AskRejection, formatAskRejection } from './ask-rejection.js';

describe('formatAskRejection', () => {
  it.each<[AskRejection, string]>([
    [{ kind: 'not-wired' }, '/ask is not wired up — NotebookLM adapter or vault path missing.'],
    [
      { kind: 'invalid-command', reason: 'Usage: /ask <topic-slug> <question>' },
      'Usage: /ask <topic-slug> <question>',
    ],
    [
      { kind: 'topic-unavailable', reason: 'No research topic at "x".' },
      'No research topic at "x".',
    ],
    [{ kind: 'quota-exhausted' }, 'Daily NotebookLM chat quota exhausted. Try again tomorrow.'],
    [{ kind: 'notebooklm-unconfigured' }, 'NotebookLM is not configured on this reclaw instance.'],
  ])('formats %j', (rejection, reply) => {
    expect(formatAskRejection(rejection)).toBe(reply);
  });
});
