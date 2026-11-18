import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_RETRIES } from './research-machine.js';
import {
  applyStep,
  nextPendingQuestion,
  resumeContext,
  semanticCircuitBreaker,
  thrownErrorEvent,
} from './research-step.js';
import {
  type ChatResponse,
  type ResearchContext,
  type ResearchEvent,
  type ResearchState,
  type TraceEvent,
  makeResearchJobData,
} from './research-types.js';
import { generateTopicSlug } from './topic-slug.js';

function freshContext(): ResearchContext {
  const data = makeResearchJobData({
    prompt: 'AI agents',
    now: new Date('2026-03-04T10:00:00Z'),
    sourceHints: [],
    chatId: 12345,
  });
  if (!data.ok) throw new Error(data.error);
  return data.value.context;
}

const STARTED_AT_MS = Date.parse('2026-03-04T10:05:00.000Z');

// ─── resumeContext ──────────────────────────────────────────────────────────

describe('resumeContext', () => {
  const retried: ResearchContext = {
    ...freshContext(),
    retries: { creating_notebook: 2, deriving_topic: 1 },
    lastError: 'boom',
  };

  it("clears the resumed state's retry count and the last error", () => {
    expect(resumeContext({ kind: 'creating_notebook' }, retried)).toEqual({
      ...retried,
      retries: { deriving_topic: 1 },
      lastError: null,
    });
  });

  it('leaves the context alone when the resumed state has no retries', () => {
    expect(resumeContext({ kind: 'searching_sources' }, retried)).toBe(retried);
  });

  it('leaves a terminal state untouched', () => {
    expect(resumeContext({ kind: 'done' }, retried)).toBe(retried);
    expect(
      resumeContext({ kind: 'failed', error: 'x', failedState: 'creating_notebook' }, retried),
    ).toBe(retried);
  });

  it('ignores Object.prototype names in the retry table', () => {
    const state = { kind: 'constructor' } as unknown as ResearchState;
    expect(resumeContext(state, retried)).toBe(retried);
  });

  it('property: resuming twice is resuming once', () => {
    const resumable = fc.constantFrom<ResearchState>(
      { kind: 'deriving_topic' },
      { kind: 'creating_notebook' },
      { kind: 'searching_sources' },
      { kind: 'adding_sources' },
      { kind: 'writing_vault' },
      { kind: 'notifying' },
    );
    const retryTable = fc.dictionary(
      resumable.map((s) => s.kind),
      fc.nat({ max: 5 }),
    );
    fc.assert(
      fc.property(resumable, retryTable, fc.option(fc.string()), (state, retries, lastError) => {
        const once = resumeContext(state, { ...freshContext(), retries, lastError });
        expect(resumeContext(state, once)).toEqual(once);
        expect(Object.hasOwn(once.retries, state.kind)).toBe(false);
      }),
    );
  });
});

// ─── nextPendingQuestion ────────────────────────────────────────────────────

describe('nextPendingQuestion', () => {
  const answer: ChatResponse = { text: 'An answer.', citations: [1], rawData: null };

  it('picks the first question neither answered nor skipped', () => {
    const ctx: ResearchContext = {
      ...freshContext(),
      questions: ['Q1?', 'Q2?', 'Q3?'],
      answers: { 'Q1?': answer },
      skippedQuestions: ['Q2?'],
    };
    expect(nextPendingQuestion(ctx)).toBe('Q3?');
  });

  it('is undefined once every question is answered or skipped', () => {
    const ctx: ResearchContext = {
      ...freshContext(),
      questions: ['Q1?', 'Q2?'],
      answers: { 'Q1?': answer },
      skippedQuestions: ['Q2?'],
    };
    expect(nextPendingQuestion(ctx)).toBeUndefined();
  });

  it('asks a question named like an Object.prototype member', () => {
    const ctx: ResearchContext = { ...freshContext(), questions: ['constructor', 'toString'] };
    expect(nextPendingQuestion(ctx)).toBe('constructor');
  });

  it('property: every question before the pick is settled, and the pick is not', () => {
    const names: readonly string[] = ['Q1?', 'Q2?', 'Q3?', 'constructor', '__proto__'];
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...names)),
        fc.subarray([...names]),
        fc.subarray([...names]),
        (questions, answered, skippedQuestions) => {
          // defineProperty: a plain `answers['__proto__'] = …` would set the prototype instead.
          const answers: Record<string, ChatResponse> = {};
          for (const q of answered) {
            Object.defineProperty(answers, q, { value: answer, enumerable: true });
          }
          const ctx: ResearchContext = { ...freshContext(), questions, answers, skippedQuestions };
          const settled = (q: string) => answered.includes(q) || skippedQuestions.includes(q);
          const pick = nextPendingQuestion(ctx);
          const end = pick === undefined ? questions.length : questions.indexOf(pick);
          expect(questions.slice(0, end).every(settled)).toBe(true);
          if (pick !== undefined) expect(settled(pick)).toBe(false);
        },
      ),
    );
  });
});

// ─── semanticCircuitBreaker ─────────────────────────────────────────────────

describe('semanticCircuitBreaker', () => {
  const response = (length: number, citations: readonly number[]): ChatResponse => ({
    text: `  ${'x'.repeat(length)}  `,
    citations: [...citations],
    rawData: null,
  });

  it('trips on an uncited answer shorter than 100 characters, naming its length', () => {
    expect(semanticCircuitBreaker(response(99, []))).toBe(
      'Semantic circuit breaker: response has 0 citations and is too short (99 chars < 100)',
    );
  });

  it('holds for an uncited answer of 100 characters (trimmed)', () => {
    expect(semanticCircuitBreaker(response(100, []))).toBeNull();
  });

  it('property: a cited answer never trips it, whatever its length', () => {
    fc.assert(
      fc.property(fc.nat({ max: 200 }), fc.array(fc.nat(), { minLength: 1 }), (length, cites) => {
        expect(semanticCircuitBreaker(response(length, cites))).toBeNull();
      }),
    );
  });
});

// ─── thrownErrorEvent ───────────────────────────────────────────────────────

describe('thrownErrorEvent', () => {
  it.each([
    'Unauthorized',
    'HTTP 401',
    'got 403',
    'Forbidden resource',
    'Invalid notebook',
    'notebook not found',
    '404 page',
    'Permission denied',
    'ACCESS DENIED',
    'Authentication required',
    'auth_error: token',
  ])('classifies "%s" as non-retriable', (message) => {
    expect(thrownErrorEvent(new Error(message))).toEqual({
      type: 'ERROR',
      error: message,
      retriable: false,
    });
  });

  it.each(['ECONNRESET', 'socket hang up', 'timeout after 30s', 'rate limited'])(
    'classifies "%s" as retriable',
    (message) => {
      expect(thrownErrorEvent(new Error(message))).toEqual({
        type: 'ERROR',
        error: message,
        retriable: true,
      });
    },
  );

  it('stringifies a thrown non-Error', () => {
    expect(thrownErrorEvent('plain failure')).toEqual({
      type: 'ERROR',
      error: 'plain failure',
      retriable: true,
    });
  });
});

// ─── applyStep ──────────────────────────────────────────────────────────────

describe('applyStep', () => {
  const step = (state: ResearchState, event: ResearchEvent, context = freshContext()) =>
    applyStep({ state, context, event, startedAtMs: STARTED_AT_MS, durationMs: 1234 });

  const lastTrace = (context: ResearchContext): TraceEvent | undefined => context.trace.at(-1);

  it('transitions on success and traces the event type', () => {
    const next = step(
      { kind: 'deriving_topic' },
      { type: 'TOPIC_DERIVED', topic: 'AI agents', topicSlug: generateTopicSlug('AI agents') },
    );
    expect(next.state).toEqual({ kind: 'creating_notebook' });
    expect(lastTrace(next.context)).toEqual({
      state: 'deriving_topic',
      timestamp: '2026-03-04T10:05:00.000Z',
      durationMs: 1234,
      outcome: 'success',
      detail: 'TOPIC_DERIVED',
    });
  });

  it('traces a retriable error under the retry limit as a retry', () => {
    const next = step(
      { kind: 'creating_notebook' },
      { type: 'ERROR', error: 'flaky', retriable: true },
    );
    expect(lastTrace(next.context)).toMatchObject({ outcome: 'retry', detail: 'flaky' });
  });

  it('traces a retriable error at the retry limit as a failure', () => {
    const limit = MAX_RETRIES.creating_notebook;
    const next = step(
      { kind: 'creating_notebook' },
      { type: 'ERROR', error: 'flaky', retriable: true },
      { ...freshContext(), retries: { creating_notebook: limit } },
    );
    expect(lastTrace(next.context)).toMatchObject({ outcome: 'fail', detail: 'flaky' });
  });

  it('traces a non-retriable error as a failure', () => {
    const next = step(
      { kind: 'creating_notebook' },
      { type: 'ERROR', error: 'forbidden', retriable: false },
    );
    expect(lastTrace(next.context)).toMatchObject({ outcome: 'fail', detail: 'forbidden' });
  });

  it('traces a skipped question with its reason', () => {
    const next = step(
      { kind: 'querying', questionsRemaining: 2 },
      { type: 'QUERY_SKIPPED', question: 'Why?', reason: 'Non-retriable error: nope' },
      { ...freshContext(), notebookId: 'nb', questions: ['Why?', 'How?'] },
    );
    expect(lastTrace(next.context)).toMatchObject({
      outcome: 'skip',
      detail: 'Skipped question: Why?. Reason: Non-retriable error: nope',
    });
  });

  it('records the chat count an answered question brings the job to', () => {
    const next = step(
      { kind: 'querying', questionsRemaining: 1 },
      {
        type: 'QUERY_ANSWERED',
        question: 'Why?',
        answer: { text: 'Because.', citations: [], rawData: null },
      },
      { ...freshContext(), notebookId: 'nb', questions: ['Why?'], chatsUsed: 3 },
    );
    expect(lastTrace(next.context)).toMatchObject({ outcome: 'success', chatsUsed: 4 });
  });

  it('property: a step appends exactly one trace event and keeps the earlier ones', () => {
    const earlier: TraceEvent = {
      state: 'deriving_topic',
      timestamp: '2026-03-04T10:00:00.000Z',
      durationMs: 1,
      outcome: 'success',
      detail: 'TOPIC_DERIVED',
    };
    fc.assert(
      fc.property(
        fc.array(fc.constant(earlier), { maxLength: 5 }),
        fc.string(),
        fc.boolean(),
        (trace, error, retriable) => {
          const before = { ...freshContext(), trace };
          const next = step(
            { kind: 'creating_notebook' },
            { type: 'ERROR', error, retriable },
            before,
          );
          expect(next.context.trace).toHaveLength(trace.length + 1);
          expect(next.context.trace.slice(0, trace.length)).toEqual(trace);
        },
      ),
    );
  });
});
