// ─── Research Handler Tests ────────────────────────────────────────────────────
//
// Integration tests for handleResearchJob().
// Tests the full state machine loop with mocked deps.
//
// SC-002: Crash recovery — resumes from last checkpoint.
// SC-003: State machine checkpointing enables resumption.
// US4:    Partial success (3/5 questions answered, skipped noted).
// US5:    Crash recovery — job resumes from last checkpoint.
// FR-005: Checkpoint after every transition.
// FR-080: Trace event per state transition.
// FR-081: Progress reported as percentage.

import { describe, expect, it, vi } from 'vitest';
import type { ResearchContext, ResearchJobData } from '../core/research-types.js';
import { makeResearchJobData } from '../core/research-types.js';
import {
  type ResearchDepsScript,
  makeMockChatResponse,
  makeMockResearchDeps,
  makeMockSource,
} from './__fixtures__/research.js';
import { type ResearchJobLike, handleResearchJob } from './research-handler.js';
import type { ResearchDeps } from './research-states.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeInitialJobData(): ResearchJobData {
  const result = makeResearchJobData({
    now: new Date('2026-03-05T10:00:00.000Z'),
    prompt: 'AI agents',
    sourceHints: [],
    chatId: 12345,
  });
  if (!result.ok) throw new Error('makeResearchJobData failed in test setup');
  return result.value;
}

// ─── Mock Factories ────────────────────────────────────────────────────────────

const HANDLER_SCRIPT: ResearchDepsScript = {
  webSources: [{ title: 'Source 1', url: 'https://example.com/1' }],
  discoveredSourceIds: ['id-1'],
  derivedTopic: 'AI agents',
  reformulatedQuery: 'improved query',
  rephrasedQuestion: 'rephrased?',
  claudeUrls: ['https://claude-found.com/article1'],
};

const makeMockDeps = (overrides: Partial<ResearchDeps> = {}): ResearchDeps =>
  makeMockResearchDeps(HANDLER_SCRIPT, overrides);

function makeMockJob(jobData: ResearchJobData): ResearchJobLike & {
  updateData: ReturnType<typeof vi.fn>;
  updateProgress: ReturnType<typeof vi.fn>;
} {
  return {
    data: jobData,
    updateData: vi.fn().mockResolvedValue(undefined),
    updateProgress: vi.fn().mockResolvedValue(undefined),
  };
}

// ─── Full pipeline tests ───────────────────────────────────────────────────────

describe('handleResearchJob', () => {
  it('completes the full pipeline from idle to done', async () => {
    const jobData = makeInitialJobData();
    const job = makeMockJob(jobData);
    const deps = makeMockDeps();

    const result = await handleResearchJob(job, deps);

    expect(result.topic).toBe('AI agents');
    expect(result.hubPath).toBe('/vault/research/runs/ai-agents/_index.md');
  });

  it('checkpoints after every state transition (FR-005)', async () => {
    const jobData = makeInitialJobData();
    const job = makeMockJob(jobData);
    const deps = makeMockDeps();

    await handleResearchJob(job, deps);

    // Should have called updateData multiple times (once per state transition)
    expect(job.updateData).toHaveBeenCalled();
    const callCount = job.updateData.mock.calls.length;
    // There are 9 non-terminal states + querying cycles (3 questions)
    // Minimum: creating_notebook, searching_sources, adding_sources, awaiting_processing,
    //          generating_questions, querying x3, resolving_citations, writing_vault, notifying, done
    expect(callCount).toBeGreaterThanOrEqual(9);
  });

  it('reports progress via updateProgress (FR-081)', async () => {
    const jobData = makeInitialJobData();
    const job = makeMockJob(jobData);
    const deps = makeMockDeps();

    await handleResearchJob(job, deps);

    // Should have called updateProgress multiple times
    expect(job.updateProgress).toHaveBeenCalled();

    // The last call should have progress = 100 (done state)
    const lastCall = job.updateProgress.mock.calls[job.updateProgress.mock.calls.length - 1];
    expect(lastCall?.[0]).toBe(100);
  });

  it('records trace events for each state (FR-080)', async () => {
    const jobData = makeInitialJobData();
    const job = makeMockJob(jobData);
    const deps = makeMockDeps();

    await handleResearchJob(job, deps);

    // Get the final context from the last updateData call
    const finalData = job.updateData.mock.calls[
      job.updateData.mock.calls.length - 1
    ]?.[0] as ResearchJobData;
    const trace = finalData?.context?.trace ?? [];

    // Should have trace events for each state executed
    expect(trace.length).toBeGreaterThanOrEqual(9);

    // Each trace event should have required fields (FR-082)
    for (const event of trace) {
      expect(event).toHaveProperty('state');
      expect(event).toHaveProperty('timestamp');
      expect(event).toHaveProperty('durationMs');
      expect(event).toHaveProperty('outcome');
      expect(event).toHaveProperty('detail');
      expect(typeof event.durationMs).toBe('number');
    }
  });

  it('throws on failed terminal state (triggers BullMQ failure handling)', async () => {
    const jobData = makeInitialJobData();
    const job = makeMockJob(jobData);
    const deps = makeMockDeps({
      notebookLM: {
        ...makeMockDeps().notebookLM,
        createNotebook: vi.fn().mockResolvedValue({
          ok: false,
          error: { message: 'Permanent failure', retriable: false },
        }),
      },
    });

    await expect(handleResearchJob(job, deps)).rejects.toThrow(/Research pipeline failed/);
  });

  it('sends Telegram error message on permanent pipeline failure (FR-062)', async () => {
    const jobData = makeInitialJobData();
    const job = makeMockJob(jobData);
    const deps = makeMockDeps({
      notebookLM: {
        ...makeMockDeps().notebookLM,
        createNotebook: vi.fn().mockResolvedValue({
          ok: false,
          error: { message: 'Auth error - permanent', retriable: false },
        }),
      },
    });

    await expect(handleResearchJob(job, deps)).rejects.toThrow();

    // FR-062: Telegram error must be sent containing topic, failed state, and error
    expect(deps.telegram.sendMessage).toHaveBeenCalledWith(
      12345,
      expect.stringContaining('Research failed: "AI agents"'),
    );
    const errorMsg = (deps.telegram.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as string;
    expect(errorMsg).toContain('creating_notebook');
    expect(errorMsg).toContain('Auth error - permanent');
  });

  it('still throws even if Telegram error notification fails (FR-062 best effort)', async () => {
    const jobData = makeInitialJobData();
    const job = makeMockJob(jobData);
    const deps = makeMockDeps({
      notebookLM: {
        ...makeMockDeps().notebookLM,
        createNotebook: vi.fn().mockResolvedValue({
          ok: false,
          error: { message: 'Permanent failure', retriable: false },
        }),
      },
      telegram: {
        ...makeMockDeps().telegram,
        sendMessage: vi.fn().mockRejectedValue(new Error('Telegram down')),
      },
    });

    // Should still throw with pipeline error despite Telegram failure
    await expect(handleResearchJob(job, deps)).rejects.toThrow(/Research pipeline failed/);
  });

  it('exhausts retries and then fails (no infinite loop)', async () => {
    const jobData = makeInitialJobData();
    const job = makeMockJob(jobData);
    const deps = makeMockDeps({
      notebookLM: {
        ...makeMockDeps().notebookLM,
        createNotebook: vi.fn().mockResolvedValue({
          ok: false,
          error: { message: 'Network error', retriable: true },
        }),
      },
    });

    // MAX_RETRIES for creating_notebook = 2, so this will fail after 3 total attempts
    await expect(handleResearchJob(job, deps)).rejects.toThrow();
    // Should have called createNotebook 3 times (initial + 2 retries)
    expect(deps.notebookLM.createNotebook).toHaveBeenCalledTimes(3);
  });

  it('resumes from mid-pipeline checkpoint (SC-002, SC-003, US5)', async () => {
    // Simulate a job that was checkpointed after generating_questions
    // (as if the process crashed mid-querying)
    const source = makeMockSource();
    const baseData = makeInitialJobData();

    // Build a context that's already at the querying state
    // (topic was derived in deriving_topic before the crash)
    const checkpointContext: ResearchContext = {
      ...baseData.context,
      topic: 'AI agents',
      topicSlug: 'ai-agents' as ResearchContext['topicSlug'],
      notebookId: 'nb-001',
      sources: [source],
      questions: ['Q1?', 'Q2?'],
      // Q1 is already answered (survived the crash)
      answers: { 'Q1?': makeMockChatResponse() },
    };

    const checkpointData: ResearchJobData = {
      ...baseData,
      state: { kind: 'querying', questionsRemaining: 1 },
      context: checkpointContext,
    };

    const job = makeMockJob(checkpointData);
    const deps = makeMockDeps();

    const result = await handleResearchJob(job, deps);

    expect(result.topic).toBe('AI agents');
    // Should NOT have called createNotebook (we're past that state)
    expect(deps.notebookLM.createNotebook).not.toHaveBeenCalled();
    // Should NOT have called generateQuestions (we're past that state)
    expect(deps.researchLLM.generateQuestions).not.toHaveBeenCalled();
    // Should have called chat for Q2 only (Q1 already answered)
    expect(deps.notebookLM.chat).toHaveBeenCalledWith('nb-001', 'Q2?');
    expect(deps.notebookLM.chat).toHaveBeenCalledTimes(1);
  });

  it('handles partial success (US4) — skipped questions are noted in context', async () => {
    const jobData = makeInitialJobData();
    const job = makeMockJob(jobData);

    let chatCallCount = 0;
    const deps = makeMockDeps({
      notebookLM: {
        ...makeMockDeps().notebookLM,
        chat: vi.fn().mockImplementation(async () => {
          chatCallCount++;
          // Q1 fails permanently (non-retriable), Q2 and Q3 succeed
          if (chatCallCount === 1) {
            return { ok: false, error: { message: 'Permanent error', retriable: false } };
          }
          return { ok: true, value: makeMockChatResponse() };
        }),
      },
    });

    const result = await handleResearchJob(job, deps);

    expect(result.topic).toBe('AI agents');

    // Verify the context shows 1 skipped and 2 answered
    const finalData = job.updateData.mock.calls[
      job.updateData.mock.calls.length - 1
    ]?.[0] as ResearchJobData;
    const skipped = finalData?.context?.skippedQuestions ?? [];
    expect(skipped.length).toBe(1);
    const answered = Object.keys(finalData?.context?.answers ?? {});
    expect(answered.length).toBe(2);
  });

  it('emergency fallback is used when vault write fails (FR-052)', async () => {
    const jobData = makeInitialJobData();
    const job = makeMockJob(jobData);
    const deps = makeMockDeps({
      vaultWriter: {
        writeNotes: vi.fn().mockResolvedValue({ ok: false, error: 'Disk full' }),
        writeEmergencyNote: vi.fn().mockResolvedValue({
          ok: true,
          value: '/vault/research/runs/ai-agents/_emergency.md',
        }),
        appendToNote: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      },
    });

    const result = await handleResearchJob(job, deps);

    // Job completes successfully even with structured write failure
    expect(result.topic).toBe('AI agents');
    expect(deps.vaultWriter.writeEmergencyNote).toHaveBeenCalled();
    // hubPath is set to emergency note path
    expect(result.hubPath).toContain('_emergency.md');
  });

  it('notifying errors are treated as non-fatal (FR-052 for notifying)', async () => {
    const jobData = makeInitialJobData();
    const job = makeMockJob(jobData);
    let notifyAttempt = 0;
    const deps = makeMockDeps({
      telegram: {
        ...makeMockDeps().telegram,
        sendMessage: vi.fn().mockImplementation(async () => {
          notifyAttempt++;
          // Fail first 2 times, succeed on 3rd (max retries for notifying = 2)
          if (notifyAttempt <= 2) {
            throw new Error('Telegram down');
          }
          return 1;
        }),
      },
    });

    // Should complete (notifying exhausting retries -> done, per FR-052)
    const result = await handleResearchJob(job, deps);
    expect(result.topic).toBe('AI agents');
  });

  it('does NOT checkpoint failed terminal state (SC-003)', async () => {
    const jobData = makeInitialJobData();
    const job = makeMockJob(jobData);
    const deps = makeMockDeps({
      notebookLM: {
        ...makeMockDeps().notebookLM,
        createNotebook: vi.fn().mockResolvedValue({
          ok: false,
          error: { message: 'Permission denied', retriable: false },
        }),
      },
    });

    await expect(handleResearchJob(job, deps)).rejects.toThrow();

    // updateData should NOT have been called with a failed state —
    // the only checkpoint would be a non-terminal state.
    for (const call of job.updateData.mock.calls) {
      const data = call[0] as ResearchJobData;
      expect(data.state.kind).not.toBe('failed');
    }
  });

  it('resets retry counters for current state on BullMQ resume (SC-003)', async () => {
    // Simulate a job that was checkpointed at searching_sources with
    // exhausted retries — as if the previous BullMQ attempt failed there.
    const baseData = makeInitialJobData();
    const checkpointContext: ResearchContext = {
      ...baseData.context,
      topic: 'AI agents',
      topicSlug: 'ai-agents' as ResearchContext['topicSlug'],
      notebookId: 'nb-001',
      retries: { searching_sources: 2 },
      lastError: 'Previous failure',
    };

    const checkpointData: ResearchJobData = {
      ...baseData,
      state: { kind: 'searching_sources' },
      context: checkpointContext,
    };

    const job = makeMockJob(checkpointData);
    const deps = makeMockDeps();

    const result = await handleResearchJob(job, deps);

    expect(result.topic).toBe('AI agents');
    // Should have called searchWeb — meaning the retries were cleared and
    // the state was re-executed instead of immediately failing.
    expect(deps.notebookLM.searchWeb).toHaveBeenCalled();
  });

  it('treats thrown auth errors as non-retriable (immediate failure)', async () => {
    const jobData = makeInitialJobData();
    const job = makeMockJob(jobData);
    const deps = makeMockDeps({
      notebookLM: {
        ...makeMockDeps().notebookLM,
        createNotebook: vi.fn().mockRejectedValue(new Error('401 Unauthorized')),
      },
    });

    await expect(handleResearchJob(job, deps)).rejects.toThrow(/Research pipeline failed/);
    // Should NOT retry — only 1 call, then immediate failure
    expect(deps.notebookLM.createNotebook).toHaveBeenCalledTimes(1);
  });

  it('treats thrown network errors as retriable (retries before failing)', async () => {
    const jobData = makeInitialJobData();
    const job = makeMockJob(jobData);
    const deps = makeMockDeps({
      notebookLM: {
        ...makeMockDeps().notebookLM,
        createNotebook: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      },
    });

    await expect(handleResearchJob(job, deps)).rejects.toThrow(/Research pipeline failed/);
    // Should retry — initial + 2 retries (MAX_RETRIES for creating_notebook = 2)
    expect(deps.notebookLM.createNotebook).toHaveBeenCalledTimes(3);
  });

  it('sends Telegram notification via sendMessage (FR-060)', async () => {
    const jobData = makeInitialJobData();
    const job = makeMockJob(jobData);
    const deps = makeMockDeps();

    await handleResearchJob(job, deps);

    expect(deps.telegram.sendMessage).toHaveBeenCalledWith(
      12345,
      expect.stringContaining('Research Complete'),
    );
  });
});
