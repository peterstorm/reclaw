import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type CardSpec, defaultCards, renderNote } from './__fixtures__/learning.js';
import type { TopicSlug } from './curriculum.js';
import { parseMasterNote } from './master-note.js';

const slug = 'kv-cache' as TopicSlug;

const errorsOf = (markdown: string): string => {
  const result = parseMasterNote(markdown, slug);
  return result.ok ? '' : result.error.join('\n');
};

describe('parseMasterNote', () => {
  it('parses lessons, pretests and cards with global ids', () => {
    const result = parseMasterNote(renderNote({ slug, lessons: 3, cardsPerLesson: 2 }), slug);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.title).toBe('Note kv-cache');
    expect(result.value.minutes).toBe(36);
    expect(result.value.lessons.map((l) => [l.number, l.title])).toEqual([
      [1, 'Part 1'],
      [2, 'Part 2'],
      [3, 'Part 3'],
    ]);
    expect(result.value.lessons[0]?.pretest).toEqual(['Pretest 1a?', 'Pretest 1b?']);
    expect(result.value.cards[0]).toEqual({
      id: 'kv-cache/c01',
      topic: 'kv-cache',
      lesson: 1,
      question: 'Question 1?',
      answer: 'Answer 1.',
    });
  });

  it('keeps multi-line answers and ignores prose after a card block', () => {
    const cards: CardSpec[] = [
      ...defaultCards(2, 3),
      { id: 'c99', lesson: 2, question: 'Why?', answer: 'Line one.\n\n- bullet' },
    ];
    // A blank `>` line inside a callout is still part of it.
    const md = renderNote({ slug, lessons: 2, cards }).replace('> \n> - bullet', '>\n> - bullet');
    const result = parseMasterNote(md, slug);
    expect(result.ok && result.value.cards.at(-1)?.answer).toBe('Line one.\n\n- bullet');
  });

  it.each([
    ['wrong slug', renderNote({ slug: 'other', lessons: 2 }), 'expected "kv-cache"'],
    [
      'too few lessons',
      renderNote({ slug, lessons: 1, cardsPerLesson: 6 }),
      'expected 2–4 lessons',
    ],
    [
      'too many lessons',
      renderNote({ slug, lessons: 5, cardsPerLesson: 2 }),
      'expected 2–4 lessons',
    ],
    [
      'a card for a missing lesson',
      renderNote({
        slug,
        lessons: 2,
        cards: [...defaultCards(2, 3), { id: 'c09', lesson: 4, question: 'Q?', answer: 'A.' }],
      }),
      'references L4',
    ],
    [
      'a duplicate card id',
      renderNote({
        slug,
        lessons: 2,
        cards: [...defaultCards(2, 3), { id: 'c01', lesson: 1, question: 'Q?', answer: 'A.' }],
      }),
      'duplicate id',
    ],
    [
      'an empty answer',
      renderNote({
        slug,
        lessons: 2,
        cards: [...defaultCards(2, 3), { id: 'c09', lesson: 1, question: 'Q?', answer: '' }],
      }),
      'empty answer',
    ],
    [
      'a lesson with one card',
      renderNote({
        slug,
        lessons: 2,
        cards: [...defaultCards(1, 6), { id: 'c09', lesson: 2, question: 'Q?', answer: 'A.' }],
      }),
      'Lesson 2: 1 recall cards',
    ],
  ])('rejects %s', (_, markdown, message) => {
    expect(errorsOf(markdown)).toContain(message);
  });

  it('rejects missing frontmatter, missing card section and a lesson without pretest', () => {
    expect(errorsOf('# no frontmatter')).toContain('missing frontmatter');
    const note = renderNote({ slug, lessons: 2 });
    expect(errorsOf(note.replace('## Recall cards', '## Cards'))).toContain('Recall cards');
    expect(errorsOf(note.replace('> 1. Pretest 2a?\n> 2. Pretest 2b?', '> nothing'))).toContain(
      'Lesson 2: no numbered pretest',
    );
  });

  it('reports lesson numbering gaps', () => {
    const note = renderNote({ slug, lessons: 3, cardsPerLesson: 2 }).replace(
      '## Lesson 2 —',
      '## Lesson 7 —',
    );
    expect(errorsOf(note)).toContain('found Lesson 7, expected 2');
  });

  // Regression: a card header that misses the strict grammar used to be skipped silently,
  // leaving a note that validated while scheduling fewer cards than it showed.
  it.each([
    ['a hyphen instead of a middle dot', '> [!question]- c02 - L1 - Question 2?'],
    ['a missing collapse marker', '> [!question] c02 · L1 · Question 2?'],
    ['a line separator inside the question', '> [!question]- c02 · L1 · Ques tion 2?'],
    ['a non-numeric id', '> [!question]- cXY · L1 · Question 2?'],
  ])('rejects a malformed card header with %s', (_, header) => {
    const note = renderNote({ slug, lessons: 2, cardsPerLesson: 4 }).replace(
      '> [!question]- c02 · L1 · Question 2?',
      header,
    );
    expect(errorsOf(note)).toContain('malformed card header');
  });

  it('never silently drops a question callout (property)', () => {
    // Any mutation of a valid header either still parses to the same card count or errors.
    const mutated = fc.constantFrom('·', ' ', '-', '', ' ', ' ', 'L', 'c');
    fc.assert(
      fc.property(mutated, fc.nat({ max: 30 }), (ch, at) => {
        const header = '> [!question]- c02 · L1 · Question 2?';
        const broken = header.slice(0, at) + ch + header.slice(at + 1);
        const note = renderNote({ slug, lessons: 2, cardsPerLesson: 4 }).replace(header, broken);
        const result = parseMasterNote(note, slug);
        return !result.ok || result.value.cards.length === 8;
      }),
    );
  });

  it('round-trips any rendered card set (property)', () => {
    const text = fc
      .string({ minLength: 1, maxLength: 40 })
      .map((s) => s.replace(/[\n\r>·]/g, ' ').trim())
      .filter((s) => s !== '');
    const notes = fc.integer({ min: 2, max: 4 }).chain((lessons) =>
      fc
        .array(fc.tuple(fc.integer({ min: 1, max: lessons }), text, text), {
          minLength: Math.max(6, lessons * 2),
          maxLength: 24,
        })
        .map((raw) => {
          // Guarantee ≥2 cards per lesson, then the random remainder.
          const forced = Array.from({ length: lessons * 2 }, (_, i) => Math.floor(i / 2) + 1);
          return {
            lessons,
            cards: raw.map(([lesson, question, answer], i) => ({
              id: `c${String(i + 1).padStart(2, '0')}`,
              lesson: forced[i] ?? lesson,
              question,
              answer,
            })),
          };
        }),
    );
    fc.assert(
      fc.property(notes, ({ lessons, cards }) => {
        const result = parseMasterNote(renderNote({ slug, lessons, cards }), slug);
        if (!result.ok) return false;
        return (
          JSON.stringify(result.value.cards.map((c) => [c.lesson, c.question, c.answer])) ===
          JSON.stringify(cards.map((c) => [c.lesson, c.question, c.answer]))
        );
      }),
    );
  });
});
