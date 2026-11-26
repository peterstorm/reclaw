import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  GRADES,
  MAX_EVIDENCE_PER_SUBMISSION,
  MAX_PROPOSAL_OUTCOME_CHARS,
  MAX_PROPOSAL_REASON_CHARS,
  MAX_PROPOSAL_TITLE_CHARS,
  MAX_SIGNAL_SOURCE_CHARS,
  MAX_SIGNAL_TAKEAWAY_CHARS,
  MAX_SIGNAL_TITLE_CHARS,
  type ProposalSlug,
  type StudyEvent,
  parseStudyLog,
  roundIdAt,
  serializeEvent,
  serializeWritable,
} from './study-log.js';

const instant = fc
  .integer({ min: Date.parse('2026-01-01'), max: Date.parse('2030-01-01') })
  .map((t) => new Date(t).toISOString());
const id = fc.stringMatching(/^[a-z][a-z0-9-]{0,20}(\/c\d{2})?$/);

const proposalSlug = fc.stringMatching(
  /^[a-z][a-z0-9]{0,10}(-[a-z0-9]{1,6}){0,3}$/,
) as fc.Arbitrary<ProposalSlug>;

const event: fc.Arbitrary<StudyEvent> = fc.oneof(
  fc.record({
    kind: fc.constant('lesson-read' as const),
    at: instant,
    topic: id,
    lesson: fc.integer({ min: 1, max: 4 }),
  }),
  fc.record({
    kind: fc.constant('round-asked' as const),
    at: instant,
    round: id,
    cards: fc.array(id, { minLength: 1, maxLength: 5 }),
  }),
  fc.record(
    {
      kind: fc.constant('card-graded' as const),
      at: instant,
      round: id,
      card: id,
      grade: fc.constantFrom(...GRADES),
      answer: fc.string({ maxLength: 200 }),
    },
    { requiredKeys: ['kind', 'at', 'round', 'card', 'grade'] },
  ),
  fc.record({
    kind: fc.constant('card-suspended' as const),
    at: instant,
    card: id,
    reason: fc.string(),
  }),
  fc.record({ kind: fc.constant('card-unsuspended' as const), at: instant, card: id }),
  fc.record({
    kind: fc.constant('feynman-checked' as const),
    at: instant,
    topic: id,
    gaps: fc.array(fc.string()),
  }),
  fc.record({
    kind: fc.constant('signal-noted' as const),
    at: instant,
    topic: id,
    ref: fc.webUrl(),
    source: fc.string({ minLength: 1, maxLength: MAX_SIGNAL_SOURCE_CHARS }),
    title: fc.string({ minLength: 1, maxLength: MAX_SIGNAL_TITLE_CHARS }),
    takeaway: fc.string({ minLength: 1, maxLength: MAX_SIGNAL_TAKEAWAY_CHARS }),
  }),
  fc.record({
    kind: fc.constant('signals-reviewed' as const),
    at: instant,
    topic: id,
    through: instant,
    used: fc.integer({ min: 0, max: 100 }),
  }),
  fc.record({
    kind: fc.constant('topic-proposed' as const),
    at: instant,
    slug: proposalSlug,
    title: fc.string({ minLength: 1, maxLength: MAX_PROPOSAL_TITLE_CHARS }),
    domain: id,
    subdomain: id,
    outcome: fc.string({ minLength: 1, maxLength: MAX_PROPOSAL_OUTCOME_CHARS }),
    evidence: fc.array(
      fc.record({
        ref: fc.webUrl(),
        source: fc.string({ minLength: 1, maxLength: MAX_SIGNAL_SOURCE_CHARS }),
        title: fc.string({ minLength: 1, maxLength: MAX_SIGNAL_TITLE_CHARS }),
        takeaway: fc.string({ minLength: 1, maxLength: MAX_SIGNAL_TAKEAWAY_CHARS }),
      }),
      { minLength: 1, maxLength: MAX_EVIDENCE_PER_SUBMISSION },
    ),
  }),
  fc.record({
    kind: fc.constant('proposal-dismissed' as const),
    at: instant,
    slug: proposalSlug,
    reason: fc.string({ maxLength: MAX_PROPOSAL_REASON_CHARS }),
  }),
) as fc.Arbitrary<StudyEvent>;

describe('study log', () => {
  it('round-trips any event sequence through JSONL (property)', () => {
    fc.assert(
      fc.property(fc.array(event, { maxLength: 30 }), (events) => {
        const parsed = parseStudyLog(`${events.map(serializeEvent).join('\n')}\n`);
        return parsed.ok && JSON.stringify(parsed.value) === JSON.stringify(events);
      }),
    );
  });

  it('treats an empty log as no events', () => {
    expect(parseStudyLog('')).toEqual({ ok: true, value: [] });
  });

  it('names the line of every corrupt entry instead of skipping it', () => {
    const good = serializeEvent({
      kind: 'card-unsuspended',
      at: '2026-10-17T10:00:00.000Z',
      card: 'a/c01' as never,
    });
    const result = parseStudyLog(`${good}\nnot json\n{"kind":"card-graded","at":"x"}\n`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error[0]).toContain('line 2: not JSON');
    expect(result.error[1]).toContain('line 3');
  });

  it('refuses a signal whose text is empty or over its cap, naming the line', () => {
    const base = {
      kind: 'signal-noted',
      at: '2026-11-25T22:00:00.000Z',
      topic: 'a',
      ref: 'https://example.com/x',
      source: 's',
      title: 't',
      takeaway: 'k',
    };
    const bad = [
      { ...base, takeaway: '' },
      { ...base, takeaway: 'x'.repeat(MAX_SIGNAL_TAKEAWAY_CHARS + 1) },
      { ...base, ref: undefined },
    ];
    const result = parseStudyLog(`${bad.map((e) => JSON.stringify(e)).join('\n')}\n`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toHaveLength(3);
    result.error.forEach((message, i) => {
      expect(message).toContain(`study log line ${i + 1}:`);
    });
    expect(result.error[0]).toContain('takeaway');
    expect(result.error[1]).toContain('takeaway');
    expect(result.error[2]).toContain('ref');
  });

  // A review mark only moves forward, so a corrupt one must not load as a valid mark.
  it('refuses a signals-reviewed event with a bad instant or count, naming the line', () => {
    const base = {
      kind: 'signals-reviewed',
      at: '2026-11-25T22:00:00.000Z',
      topic: 'a',
      through: '2026-11-25T21:00:00.000Z',
      used: 1,
    };
    const bad = [
      { ...base, through: 'yesterday' },
      { ...base, used: -1 },
      { ...base, used: 1.5 },
      { ...base, topic: '' },
    ];
    const result = parseStudyLog(`${bad.map((e) => JSON.stringify(e)).join('\n')}\n`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toHaveLength(4);
    result.error.forEach((message, i) => {
      expect(message).toContain(`study log line ${i + 1}:`);
    });
    expect(result.error[0]).toContain('through');
    expect(result.error[1]).toContain('used');
  });

  it('refuses a malformed topic proposal, naming the line', () => {
    const evidence = { ref: 'https://example.com/x', source: 's', title: 't', takeaway: 'k' };
    const base = {
      kind: 'topic-proposed',
      at: '2026-11-25T22:00:00.000Z',
      slug: 'some-topic',
      title: 'Some topic',
      domain: 'ai',
      subdomain: 'core',
      outcome: 'o',
      evidence: [evidence],
    };
    const bad = [
      { ...base, slug: 'Not A Slug' },
      { ...base, slug: 'x'.repeat(61) },
      { ...base, evidence: [] },
      { ...base, evidence: Array.from({ length: 6 }, () => evidence) },
      { ...base, evidence: [{ ...evidence, takeaway: '' }] },
      { kind: 'proposal-dismissed', at: base.at, slug: '', reason: '' },
    ];
    const result = parseStudyLog(`${bad.map((e) => JSON.stringify(e)).join('\n')}\n`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toHaveLength(6);
    result.error.forEach((message, i) => {
      expect(message).toContain(`study log line ${i + 1}:`);
    });
    expect(result.error[0]).toContain('slug');
  });

  // The invariant that keeps one bad write from making the whole log unreadable: whatever the
  // writer appends is first checked against the schema the reader enforces.
  describe('serializeWritable', () => {
    const ok = (events: readonly StudyEvent[]) => serializeWritable(events).ok;
    const dismissal = (reason: string): StudyEvent => ({
      kind: 'proposal-dismissed',
      at: '2026-11-25T22:00:00.000Z',
      slug: 'a' as ProposalSlug,
      reason,
    });

    it('accepts what the reader accepts and returns the exact lines', () => {
      const events = [dismissal('fine'), dismissal('')];
      expect(serializeWritable(events)).toEqual({ ok: true, value: events.map(serializeEvent) });
      expect(serializeWritable([])).toEqual({ ok: true, value: [] });
    });

    it('refuses an event the reader would reject, naming the problem', () => {
      const tooLong = dismissal('x'.repeat(MAX_PROPOSAL_REASON_CHARS + 1));
      const result = serializeWritable([dismissal('fine'), tooLong]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error[0]).toContain('reason');
    });

    it('agrees with parseStudyLog on every event: every generated event is writable and parses back (property)', () => {
      fc.assert(
        fc.property(fc.array(event, { maxLength: 10 }), (events) => {
          expect(ok(events)).toBe(true);
          const lines = events.map(serializeEvent).join('\n');
          expect(parseStudyLog(lines).ok).toBe(true);
        }),
      );
    });
  });

  it('derives compact, second-resolution round ids', () => {
    expect(roundIdAt(new Date('2026-10-17T09:30:05.123Z'))).toBe('r-20261017T093005Z');
  });
});
