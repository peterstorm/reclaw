import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { selectExecutionConversation } from './chat-conversation.js';
import type {
  AgentBackendName,
  AgentSessionId,
  ConversationGeneration,
  ConversationRevision,
  ConversationTarget,
} from './types.js';

const target = (
  generation: number,
  backend: AgentBackendName,
  revision = 0,
  sessionId: string | null = null,
): ConversationTarget => ({
  generation: generation as ConversationGeneration,
  revision: revision as ConversationRevision,
  backend,
  sessionId: sessionId as AgentSessionId | null,
});

const targetArb: fc.Arbitrary<ConversationTarget> = fc
  .record({
    generation: fc.nat({ max: 3 }),
    revision: fc.nat({ max: 3 }),
    backend: fc.constantFrom<AgentBackendName>('claude', 'pi'),
    sessionId: fc.option(fc.constantFrom('s-1', 's-2'), { nil: null }),
  })
  .map(({ generation, backend, revision, sessionId }) =>
    target(generation, backend, revision, sessionId),
  );

describe('selectExecutionConversation', () => {
  it('rebases onto the current conversation while generation and backend match', () => {
    const current = target(2, 'claude', 5, 's-latest');
    const captured = target(2, 'claude', 1, null);
    expect(selectExecutionConversation({ current, captured })).toBe(current);
  });

  it('keeps the ingress snapshot once the generation advanced', () => {
    const current = target(3, 'claude', 0, null);
    const captured = target(2, 'claude', 1, 's-old');
    expect(selectExecutionConversation({ current, captured })).toBe(captured);
  });

  it('keeps the ingress snapshot when the backend changed', () => {
    const current = target(2, 'pi', 0, null);
    const captured = target(2, 'claude', 1, 's-old');
    expect(selectExecutionConversation({ current, captured })).toBe(captured);
  });

  it('never executes outside the generation and backend captured at ingress', () => {
    fc.assert(
      fc.property(targetArb, targetArb, (current, captured) => {
        const chosen = selectExecutionConversation({ current, captured });
        expect(chosen.generation).toBe(captured.generation);
        expect(chosen.backend).toBe(captured.backend);
        expect([current, captured]).toContain(chosen);
      }),
    );
  });
});
