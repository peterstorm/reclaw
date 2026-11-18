// ─── deriving_topic state tests ────────────────────────────────────────────────
//
// The first pipeline state: the research LLM names the topic, the slug follows.

import { describe, expect, it, vi } from 'vitest';
import { type ResearchContext, makeResearchJobData } from '../core/research-types.js';
import { type ResearchDepsScript, makeMockResearchDeps } from './__fixtures__/research.js';
import { type ResearchDeps, executeState } from './research-states.js';

const SCRIPT: ResearchDepsScript = {
  webSources: [],
  discoveredSourceIds: [],
  derivedTopic: 'AI Agent Architectures',
  reformulatedQuery: 'AI agents',
  rephrasedQuestion: 'Rephrased?',
  claudeUrls: [],
};

function freshContext(): ResearchContext {
  const job = makeResearchJobData({
    prompt: 'tell me how AI agents are built',
    now: new Date('2026-03-04T10:00:00.000Z'),
    sourceHints: [],
    chatId: 12345,
  });
  if (!job.ok) throw new Error(job.error);
  return job.value.context;
}

function depsWithDeriveTopic(deriveTopic: ResearchDeps['researchLLM']['deriveTopic']) {
  const deps = makeMockResearchDeps(SCRIPT);
  return { ...deps, researchLLM: { ...deps.researchLLM, deriveTopic } };
}

describe('executeState / deriving_topic', () => {
  it('emits TOPIC_DERIVED with the derived topic and its slug', async () => {
    const deps = makeMockResearchDeps(SCRIPT);

    const event = await executeState({ kind: 'deriving_topic' }, freshContext(), deps);

    expect(event).toEqual({
      type: 'TOPIC_DERIVED',
      topic: 'AI Agent Architectures',
      topicSlug: 'ai-agent-architectures',
    });
    expect(deps.researchLLM.deriveTopic).toHaveBeenCalledWith('tell me how AI agents are built');
  });

  it('fails the step retriably with the derivation error, as the thrown Error read', async () => {
    const deps = depsWithDeriveTopic(
      vi.fn().mockResolvedValue({
        ok: false,
        error: 'Claude subprocess failed: claude timed out after 100ms',
      }),
    );

    const event = await executeState({ kind: 'deriving_topic' }, freshContext(), deps);

    expect(event).toEqual({
      type: 'ERROR',
      error: 'Error: Claude subprocess failed: claude timed out after 100ms',
      retriable: true,
    });
  });

  it('still turns an unexpected rejection into a retriable step failure', async () => {
    const deps = depsWithDeriveTopic(vi.fn().mockRejectedValue(new Error('runner crashed')));

    const event = await executeState({ kind: 'deriving_topic' }, freshContext(), deps);

    expect(event).toEqual({ type: 'ERROR', error: 'Error: runner crashed', retriable: true });
  });
});
