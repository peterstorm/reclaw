// ─── Master Note ──────────────────────────────────────────────────────────────
//
// A master note is a curriculum topic written for LEARNING, not reference: 2–4 short
// lessons (each opening with pretest questions) and a "Recall cards" section of
// collapsible Obsidian callouts. The callouts double as in-Obsidian self-tests and as
// the machine-readable card source for the recall loop:
//
//   ## Lesson 1 — Why decode is bandwidth-bound
//   > [!example] Before you read — guess first
//   > 1. A pretest question?
//   ...
//   ## Recall cards
//   > [!question]- c01 · L1 · The question?
//   > The reference answer, possibly
//   > over several lines.
//
// Card ids are author-assigned (`c01`) so editing a question's wording keeps its review
// history. Parsing is all-or-nothing: a note that would schedule a malformed card is
// rejected with every problem listed, never half-loaded.

import { parse as parseYaml } from 'yaml';
import type { TopicSlug } from './curriculum.js';
import { type Result, err, ok } from './types.js';

/** Globally unique card id: `<topic-slug>/<local id>`, e.g. `kv-cache/c03`. */
export type CardId = string & { readonly __brand: 'CardId' };

export const cardIdOf = (slug: TopicSlug, localId: string): CardId =>
  `${slug}/${localId}` as CardId;

export type Lesson = Readonly<{
  number: number;
  title: string;
  pretest: readonly string[];
}>;

export type RecallCard = Readonly<{
  id: CardId;
  topic: TopicSlug;
  lesson: number;
  question: string;
  answer: string;
}>;

export type MasterNote = Readonly<{
  topic: TopicSlug;
  title: string;
  minutes: number;
  lessons: readonly Lesson[];
  cards: readonly RecallCard[];
}>;

export const LESSON_BOUNDS = { min: 2, max: 4 } as const;
export const CARD_BOUNDS = { min: 6, max: 24, perLesson: 2 } as const;

const LESSON_HEADING = /^## Lesson (\d+) [—–-] (.+?)\s*$/;
const CARDS_HEADING = /^## Recall cards\s*$/;
const H2 = /^## /;
const PRETEST_CALLOUT = /^> \[!example\]/;
const NUMBERED_ITEM = /^>\s*\d+\.\s+(.+)$/;
const CARD_HEADER = /^> \[!question\]- (c\d{2,3}) · L(\d+) · (.+?)\s*$/;
/**
 * Outside a card, a line that opens a question callout (Obsidian matches callout types
 * case-insensitively) or any `>` line is a broken card — an error, never a silent drop.
 * Inside a card, `>` lines are answer text and may mention `[!question]` freely.
 */
const CARD_OPENER = /^[^\p{L}\p{N}]*\[!question\]/iu;

type Section = Readonly<{ heading: string; lines: readonly string[] }>;

function splitFrontmatter(markdown: string): Result<{ front: unknown; body: string }, string> {
  const normalized = markdown.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return err('missing frontmatter');
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) return err('unterminated frontmatter');
  try {
    return ok({
      front: parseYaml(normalized.slice(4, end)),
      body: normalized.slice(end + 4).replace(/^[^\n]*\n/, ''),
    });
  } catch (e) {
    return err(`frontmatter YAML error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function h2Sections(body: string): readonly Section[] {
  const sections: { heading: string; lines: string[] }[] = [];
  for (const line of body.split('\n')) {
    if (H2.test(line)) sections.push({ heading: line, lines: [] });
    else sections.at(-1)?.lines.push(line);
  }
  return sections;
}

function parsePretest(lines: readonly string[]): readonly string[] {
  const start = lines.findIndex((l) => PRETEST_CALLOUT.test(l));
  if (start === -1) return [];
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('>')) break;
    const item = NUMBERED_ITEM.exec(line);
    if (item?.[1] !== undefined) items.push(item[1].trim());
  }
  return items;
}

type RawCard = { localId: string; lesson: number; question: string; answer: string[] };

function parseCardBlock(lines: readonly string[]): {
  cards: readonly RawCard[];
  malformed: readonly string[];
} {
  const cards: RawCard[] = [];
  const malformed: string[] = [];
  let current: RawCard | null = null;
  for (const line of lines) {
    const header = CARD_HEADER.exec(line);
    const inAnswer = current !== null && line.startsWith('>');
    if (header === null && !inAnswer && (line.startsWith('>') || CARD_OPENER.test(line))) {
      malformed.push(line);
      current = null;
    } else if (header !== null) {
      current = {
        localId: header[1] ?? '',
        lesson: Number(header[2]),
        question: header[3] ?? '',
        answer: [],
      };
      cards.push(current);
    } else if (current !== null && line.startsWith('>')) {
      current.answer.push(line.replace(/^>\s?/, ''));
    } else {
      current = null;
    }
  }
  return { cards, malformed };
}

/** Parse a master note for `expected`. Every structural problem is reported at once. */
export function parseMasterNote(
  markdown: string,
  expected: TopicSlug,
): Result<MasterNote, readonly string[]> {
  const split = splitFrontmatter(markdown);
  if (!split.ok) return err([split.error]);
  const errors: string[] = [];

  const front = (split.value.front ?? {}) as Record<string, unknown>;
  const meta = (front.curriculum ?? {}) as Record<string, unknown>;
  const title = typeof front.title === 'string' ? front.title : '';
  if (title === '') errors.push('frontmatter: title missing');
  if (meta.slug !== expected)
    errors.push(`frontmatter: curriculum.slug is "${String(meta.slug)}", expected "${expected}"`);
  const minutes = typeof meta.minutes === 'number' ? meta.minutes : Number.NaN;
  if (!Number.isInteger(minutes) || minutes <= 0)
    errors.push('frontmatter: curriculum.minutes must be a positive integer');

  const sections = h2Sections(split.value.body);

  const lessons: Lesson[] = [];
  for (const section of sections) {
    const m = LESSON_HEADING.exec(section.heading);
    if (m === null) continue;
    const number = Number(m[1]);
    const pretest = parsePretest(section.lines);
    if (number !== lessons.length + 1)
      errors.push(`lesson numbering: found Lesson ${number}, expected ${lessons.length + 1}`);
    if (pretest.length === 0) errors.push(`Lesson ${number}: no numbered pretest questions`);
    lessons.push({ number, title: (m[2] ?? '').trim(), pretest });
  }
  if (lessons.length < LESSON_BOUNDS.min || lessons.length > LESSON_BOUNDS.max)
    errors.push(
      `expected ${LESSON_BOUNDS.min}–${LESSON_BOUNDS.max} lessons, found ${lessons.length}`,
    );

  const cardSections = sections.filter((s) => CARDS_HEADING.test(s.heading));
  if (cardSections.length !== 1)
    errors.push(`expected exactly one "## Recall cards" section, found ${cardSections.length}`);
  const block = parseCardBlock(cardSections[0]?.lines ?? []);
  for (const line of block.malformed)
    errors.push(
      `malformed card header or stray quote line in Recall cards (expected "> [!question]- cNN · LN · Question"): ${JSON.stringify(line.slice(0, 80))}`,
    );
  const rawCards = cardSections.length === 1 ? block.cards : [];

  const seen = new Set<string>();
  const cards: RecallCard[] = [];
  for (const raw of rawCards) {
    const answer = raw.answer.join('\n').trim();
    if (seen.has(raw.localId)) errors.push(`card ${raw.localId}: duplicate id`);
    seen.add(raw.localId);
    if (raw.lesson < 1 || raw.lesson > lessons.length)
      errors.push(`card ${raw.localId}: references L${raw.lesson}, which does not exist`);
    if (answer === '') errors.push(`card ${raw.localId}: empty answer`);
    cards.push({
      id: cardIdOf(expected, raw.localId),
      topic: expected,
      lesson: raw.lesson,
      question: raw.question.trim(),
      answer,
    });
  }
  if (cards.length < CARD_BOUNDS.min || cards.length > CARD_BOUNDS.max)
    errors.push(
      `expected ${CARD_BOUNDS.min}–${CARD_BOUNDS.max} recall cards, found ${cards.length}`,
    );
  for (const lesson of lessons) {
    const count = cards.filter((c) => c.lesson === lesson.number).length;
    if (count < CARD_BOUNDS.perLesson)
      errors.push(`Lesson ${lesson.number}: ${count} recall cards, need ≥${CARD_BOUNDS.perLesson}`);
  }

  if (errors.length > 0) return err(errors);
  return ok({ topic: expected, title, minutes, lessons, cards });
}
