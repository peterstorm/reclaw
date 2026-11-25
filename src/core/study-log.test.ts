import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  GRADES,
  MAX_SIGNAL_SOURCE_CHARS,
  MAX_SIGNAL_TAKEAWAY_CHARS,
  MAX_SIGNAL_TITLE_CHARS,
  type StudyEvent,
  parseStudyLog,
  roundIdAt,
  serializeEvent,
} from './study-log.js';

const instant = fc
  .integer({ min: Date.parse('2026-01-01'), max: Date.parse('2030-01-01') })
  .map((t) => new Date(t).toISOString());
const id = fc.stringMatching(/^[a-z][a-z0-9-]{0,20}(\/c\d{2})?$/);

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

  it('derives compact, second-resolution round ids', () => {
    expect(roundIdAt(new Date('2026-10-17T09:30:05.123Z'))).toBe('r-20261017T093005Z');
  });
});
