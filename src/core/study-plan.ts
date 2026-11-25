// ─── Study Plan ───────────────────────────────────────────────────────────────
//
// The functional core of the learning loop. `foldStudy` replays the study log over the
// curriculum and the parsed master notes into a `StudyState`; every decision the
// scheduled skills need is a pure function of that state and `now`:
//
//   nextLesson   — what to read next (strict study order, so prerequisites hold)
//   pickRound    — which cards to ask in a recall round (FSRS-due, interleaved)
//   gradeCard    — validate a grade and produce the event that records it
//   nextBuild    — which topic the curriculum builder should research next
//   pickFeynman  — which finished topic to explain back this week
//   summarize    — progress numbers for reviews
//
// Commands return domain events as data; the shell appends them. Scheduling uses FSRS
// with fuzz DISABLED so the same log always folds to the same schedule.

import { type Card, type Grade as FsrsGrade, Rating, State, createEmptyCard, fsrs } from 'ts-fsrs';
import type { Curriculum, StudySettings, Topic, TopicSlug } from './curriculum.js';
import { notePathFor } from './curriculum.js';
import type { CardId, Lesson, MasterNote, RecallCard } from './master-note.js';
import {
  type Grade,
  type RoundId,
  type SignalNoted,
  type StudyEvent,
  roundIdAt,
} from './study-log.js';
import { type SignalLedger, ledgerOf, oldestBatch, signalsAfter } from './topic-signals.js';
import { type Result, assertNever, err, ok } from './types.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export type GradeRecord = Readonly<{ round: RoundId; at: Date; grade: Grade }>;

export type CardProgress = Readonly<{
  card: RecallCard;
  unlockedAt: Date;
  fsrs: Card;
  suspended: boolean;
  /** Latest round the card was asked in, when it was not graded in that round. */
  pending: Readonly<{ round: RoundId; at: Date }> | null;
  /** One record per round graded, chronological; a re-grade overrides within its round. */
  grades: readonly GradeRecord[];
}>;

export type StudyState = Readonly<{
  curriculum: Curriculum;
  notes: ReadonlyMap<TopicSlug, MasterNote>;
  /** Topics whose note exists but fails to parse — treated as built, flagged for repair. */
  brokenNotes: ReadonlyMap<TopicSlug, readonly string[]>;
  /** `topic#lesson` → instant first read. */
  lessonsRead: ReadonlyMap<string, Date>;
  cards: ReadonlyMap<CardId, CardProgress>;
  rounds: ReadonlyMap<RoundId, Readonly<{ at: Date; cards: readonly CardId[] }>>;
  feynmanAt: ReadonlyMap<TopicSlug, Date>;
  /** New material tagged to registry topics, one entry per (topic, ref). Built or not. */
  signals: SignalLedger;
  /** Per topic: the newest signal instant the builder has reviewed. Later signals are pending. */
  signalsReviewedThrough: ReadonlyMap<TopicSlug, Date>;
  /** Events naming cards/topics that no longer exist in any note — kept, but ignored. */
  orphanEvents: number;
}>;

const lessonKey = (topic: TopicSlug, lesson: number): string => `${topic}#${lesson}`;

const FSRS_RATING: Readonly<Record<Grade, FsrsGrade>> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
};

const schedulerFor = (settings: StudySettings) =>
  fsrs({
    request_retention: settings.requestRetention,
    maximum_interval: 365,
    enable_fuzz: false,
    enable_short_term: true,
    // Recall happens in Telegram rounds hours apart; minute-level steps would be noise.
    learning_steps: ['3h'],
    relearning_steps: ['3h'],
  });

/** FSRS memory state after replaying `grades` (chronological) from the unlock instant. */
function scheduleCard(
  settings: StudySettings,
  unlockedAt: Date,
  grades: readonly GradeRecord[],
): Card {
  const scheduler = schedulerFor(settings);
  return grades.reduce<Card>(
    (card, g) => scheduler.next(card, g.at, FSRS_RATING[g.grade]).card,
    createEmptyCard(unlockedAt),
  );
}

// ─── Fold ─────────────────────────────────────────────────────────────────────

export function foldStudy(
  curriculum: Curriculum,
  notes: ReadonlyMap<TopicSlug, MasterNote>,
  brokenNotes: ReadonlyMap<TopicSlug, readonly string[]>,
  events: readonly StudyEvent[],
): StudyState {
  const cardIndex = new Map<CardId, RecallCard>();
  for (const note of notes.values()) for (const c of note.cards) cardIndex.set(c.id, c);

  const log = replayLog(chronological(events), curriculum, notes, cardIndex);
  return {
    curriculum,
    notes,
    brokenNotes,
    lessonsRead: log.lessonsRead,
    cards: unlockedCards(curriculum.settings, cardIndex, log),
    rounds: log.rounds,
    feynmanAt: log.feynmanAt,
    signals: ledgerOf(log.signals),
    signalsReviewedThrough: log.signalsReviewedThrough,
    orphanEvents: log.orphanEvents,
  };
}

/** Events by instant; events at the same instant keep their log order. */
const chronological = (events: readonly StudyEvent[]): readonly StudyEvent[] =>
  events
    .map((e, i) => ({ e, i, t: Date.parse(e.at) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map(({ e }) => e);

/** What replaying the study log yields, before cards are scheduled. Read-only once replayed. */
type ReplayedLog = Readonly<{
  lessonsRead: ReadonlyMap<string, Date>;
  rounds: ReadonlyMap<RoundId, Readonly<{ at: Date; cards: readonly CardId[] }>>;
  suspended: ReadonlyMap<CardId, boolean>;
  feynmanAt: ReadonlyMap<TopicSlug, Date>;
  /** Per card, per round: the first instant graded + the last grade given. */
  gradesByCard: ReadonlyMap<CardId, ReadonlyMap<RoundId, GradeRecord>>;
  /** Signals for topics still in the registry, in log order (not yet de-duplicated). */
  signals: readonly SignalNoted[];
  signalsReviewedThrough: ReadonlyMap<TopicSlug, Date>;
  orphanEvents: number;
}>;

/** The study log folded in order; the maps are filled here and nowhere else. */
function replayLog(
  ordered: readonly StudyEvent[],
  curriculum: Curriculum,
  notes: ReadonlyMap<TopicSlug, MasterNote>,
  cardIndex: ReadonlyMap<CardId, RecallCard>,
): ReplayedLog {
  const lessonsRead = new Map<string, Date>();
  const rounds = new Map<RoundId, Readonly<{ at: Date; cards: readonly CardId[] }>>();
  const suspended = new Map<CardId, boolean>();
  const feynmanAt = new Map<TopicSlug, Date>();
  const gradesByCard = new Map<CardId, Map<RoundId, GradeRecord>>();
  const signals: SignalNoted[] = [];
  const signalsReviewedThrough = new Map<TopicSlug, Date>();
  let orphanEvents = 0;
  for (const e of ordered) {
    const at = new Date(e.at);
    switch (e.kind) {
      case 'lesson-read': {
        if (!notes.has(e.topic)) orphanEvents++;
        const key = lessonKey(e.topic, e.lesson);
        if (!lessonsRead.has(key)) lessonsRead.set(key, at);
        break;
      }
      case 'round-asked':
        rounds.set(e.round, { at, cards: e.cards });
        break;
      case 'card-graded':
        if (cardIndex.has(e.card)) recordGrade(gradesByCard, e, at);
        else orphanEvents++;
        break;
      case 'card-suspended':
        suspended.set(e.card, true);
        break;
      case 'card-unsuspended':
        suspended.set(e.card, false);
        break;
      case 'feynman-checked':
        feynmanAt.set(e.topic, at);
        break;
      case 'signal-noted':
        if (curriculum.bySlug.has(e.topic)) signals.push(e);
        else orphanEvents++;
        break;
      case 'signals-reviewed': {
        if (!curriculum.bySlug.has(e.topic)) {
          orphanEvents++;
          break;
        }
        const through = new Date(e.through);
        const known = signalsReviewedThrough.get(e.topic);
        if (known === undefined || through > known) signalsReviewedThrough.set(e.topic, through);
        break;
      }
      default:
        return assertNever(e);
    }
  }
  return {
    lessonsRead,
    rounds,
    suspended,
    feynmanAt,
    gradesByCard,
    signals,
    signalsReviewedThrough,
    orphanEvents,
  };
}

/** A re-grade within a round keeps the round's first grading instant and takes the new grade. */
function recordGrade(
  gradesByCard: Map<CardId, Map<RoundId, GradeRecord>>,
  e: Extract<StudyEvent, { kind: 'card-graded' }>,
  at: Date,
): void {
  const perRound = gradesByCard.get(e.card) ?? new Map<RoundId, GradeRecord>();
  const prior = perRound.get(e.round);
  perRound.set(e.round, { round: e.round, at: prior?.at ?? at, grade: e.grade });
  gradesByCard.set(e.card, perRound);
}

/** Every card whose lesson has been read, scheduled by FSRS from its grades. */
function unlockedCards(
  settings: StudySettings,
  cardIndex: ReadonlyMap<CardId, RecallCard>,
  log: ReplayedLog,
): ReadonlyMap<CardId, CardProgress> {
  const askedIn = new Map<CardId, { round: RoundId; at: Date }>();
  for (const [round, r] of log.rounds) {
    for (const id of r.cards) askedIn.set(id, { round, at: r.at });
  }

  const cards = new Map<CardId, CardProgress>();
  for (const card of cardIndex.values()) {
    const unlockedAt = log.lessonsRead.get(lessonKey(card.topic, card.lesson));
    if (unlockedAt === undefined) continue;
    const perRound = log.gradesByCard.get(card.id);
    const grades = [...(perRound?.values() ?? [])].sort((a, b) => a.at.getTime() - b.at.getTime());
    const lastAsk = askedIn.get(card.id);
    cards.set(card.id, {
      card,
      unlockedAt,
      fsrs: scheduleCard(settings, unlockedAt, grades),
      suspended: log.suspended.get(card.id) ?? false,
      pending: lastAsk !== undefined && perRound?.has(lastAsk.round) !== true ? lastAsk : null,
      grades,
    });
  }
  return cards;
}

// ─── Reading ──────────────────────────────────────────────────────────────────

export type LessonPlan =
  | Readonly<{
      kind: 'lesson';
      topic: Topic;
      notePath: string;
      noteTitle: string;
      lesson: Lesson;
      lessonCount: number;
      minutesPerLesson: number;
      dueCards: number;
      backlogHigh: boolean;
    }>
  | Readonly<{ kind: 'awaiting-build'; topic: Topic }>
  | Readonly<{ kind: 'note-invalid'; topic: Topic; errors: readonly string[] }>
  | Readonly<{ kind: 'curriculum-complete' }>;

export const isFullyRead = (state: StudyState, topic: TopicSlug): boolean => {
  return (
    state.notes
      .get(topic)
      ?.lessons.every((l) => state.lessonsRead.has(lessonKey(topic, l.number))) === true
  );
};

/** Reading follows study order strictly; it never skips past an unbuilt or broken topic. */
export function nextLesson(state: StudyState, now: Date): LessonPlan {
  for (const topic of state.curriculum.topics) {
    const broken = state.brokenNotes.get(topic.slug);
    if (broken !== undefined) return { kind: 'note-invalid', topic, errors: broken };
    const note = state.notes.get(topic.slug);
    if (note === undefined) return { kind: 'awaiting-build', topic };
    const lesson = note.lessons.find(
      (l) => !state.lessonsRead.has(lessonKey(topic.slug, l.number)),
    );
    if (lesson === undefined) continue;
    const due = countDue(state, now);
    return {
      kind: 'lesson',
      topic,
      notePath: notePathFor(topic),
      noteTitle: note.title,
      lesson,
      lessonCount: note.lessons.length,
      minutesPerLesson: Math.round(note.minutes / note.lessons.length),
      dueCards: due,
      backlogHigh: due > state.curriculum.settings.backlogThreshold,
    };
  }
  return { kind: 'curriculum-complete' };
}

export type ReadError =
  | Readonly<{ kind: 'unknown-topic'; topic: string }>
  | Readonly<{ kind: 'not-built'; topic: TopicSlug }>
  | Readonly<{ kind: 'unknown-lesson'; topic: TopicSlug; lesson: number; lessonCount: number }>;

export type ReadOutcome =
  | Readonly<{ kind: 'recorded'; event: StudyEvent; unlockedCards: number }>
  | Readonly<{ kind: 'already-read' }>;

export function markLessonRead(
  state: StudyState,
  topicSlug: string,
  lesson: number,
  now: Date,
): Result<ReadOutcome, ReadError> {
  const topic = state.curriculum.bySlug.get(topicSlug as TopicSlug);
  if (topic === undefined) return err({ kind: 'unknown-topic', topic: topicSlug });
  const note = state.notes.get(topic.slug);
  if (note === undefined) return err({ kind: 'not-built', topic: topic.slug });
  if (!note.lessons.some((l) => l.number === lesson))
    return err({
      kind: 'unknown-lesson',
      topic: topic.slug,
      lesson,
      lessonCount: note.lessons.length,
    });
  if (state.lessonsRead.has(lessonKey(topic.slug, lesson))) return ok({ kind: 'already-read' });
  return ok({
    kind: 'recorded',
    event: { kind: 'lesson-read', at: now.toISOString(), topic: topic.slug, lesson },
    unlockedCards: note.cards.filter((c) => c.lesson === lesson).length,
  });
}

// ─── Recall ───────────────────────────────────────────────────────────────────

const isPending = (p: CardProgress, now: Date, settings: StudySettings): boolean =>
  p.pending !== null && now.getTime() - p.pending.at.getTime() < settings.pendingHours * HOUR_MS;

const isEligible = (p: CardProgress, now: Date, settings: StudySettings): boolean =>
  !p.suspended && p.fsrs.due.getTime() <= now.getTime() && !isPending(p, now, settings);

export function countDue(state: StudyState, now: Date): number {
  let n = 0;
  for (const p of state.cards.values()) if (isEligible(p, now, state.curriculum.settings)) n++;
  return n;
}

export type RoundCard = Readonly<{
  id: CardId;
  topicTitle: string;
  notePath: string;
  lesson: number;
  question: string;
  answer: string;
  isNew: boolean;
}>;

export type RoundPlan =
  | Readonly<{ kind: 'round'; round: RoundId; cards: readonly RoundCard[]; event: StudyEvent }>
  | Readonly<{ kind: 'nothing-due'; nextDueAt: Date | null; pendingCards: number }>;

/**
 * Pick up to `size` cards. Priority: short-term (learning/relearning) by due date, then
 * reviews least-likely-remembered first, then new cards in study order under the rolling
 * 24h new-card cap. Interleaving: prefer cards from topics not yet in the round.
 */
export function pickRound(state: StudyState, now: Date, size?: number): RoundPlan {
  const chosen = interleave(
    roundCandidates(state, now),
    size ?? state.curriculum.settings.roundSize,
  );
  if (chosen.length === 0) return nothingDue(state, now);

  const round = roundIdAt(now);
  return {
    kind: 'round',
    round,
    cards: chosen.map((p) => toRoundCard(state, p)),
    event: {
      kind: 'round-asked',
      at: now.toISOString(),
      round,
      cards: chosen.map((p) => p.card.id),
    },
  };
}

/** Eligible cards in priority order: short-term by due date, weakest reviews, capped new cards. */
function roundCandidates(state: StudyState, now: Date): readonly CardProgress[] {
  const settings = state.curriculum.settings;
  const scheduler = schedulerFor(settings);
  const eligible = [...state.cards.values()].filter((p) => isEligible(p, now, settings));

  const shortTerm = eligible
    .filter((p) => p.fsrs.state === State.Learning || p.fsrs.state === State.Relearning)
    .sort((a, b) => a.fsrs.due.getTime() - b.fsrs.due.getTime());
  const reviews = eligible
    .filter((p) => p.fsrs.state === State.Review)
    .map((p) => ({ p, r: scheduler.get_retrievability(p.fsrs, now, false) }))
    .sort((a, b) => a.r - b.r)
    .map(({ p }) => p);
  return [...shortTerm, ...reviews, ...freshCards(state, eligible, now)];
}

/** New cards in study order, limited to what the rolling 24h new-card cap still allows. */
function freshCards(
  state: StudyState,
  eligible: readonly CardProgress[],
  now: Date,
): readonly CardProgress[] {
  const introducedToday = [...state.cards.values()].filter((p) => {
    const first = p.grades[0];
    return first !== undefined && now.getTime() - first.at.getTime() < DAY_MS;
  }).length;
  const position = (p: CardProgress): number =>
    state.curriculum.bySlug.get(p.card.topic)?.position ?? Number.MAX_SAFE_INTEGER;
  return eligible
    .filter((p) => p.fsrs.state === State.New)
    .sort(
      (a, b) =>
        position(a) - position(b) ||
        a.card.lesson - b.card.lesson ||
        a.card.id.localeCompare(b.card.id),
    )
    .slice(0, Math.max(0, state.curriculum.settings.newCardsPerDay - introducedToday));
}

/** Up to `limit` candidates: one per topic first, then fill in priority order. */
function interleave(candidates: readonly CardProgress[], limit: number): readonly CardProgress[] {
  const chosen: CardProgress[] = [];
  const topics = new Set<TopicSlug>();
  for (const p of candidates) {
    if (chosen.length >= limit) break;
    if (!topics.has(p.card.topic)) {
      chosen.push(p);
      topics.add(p.card.topic);
    }
  }
  for (const p of candidates) {
    if (chosen.length >= limit) break;
    if (!chosen.includes(p)) chosen.push(p);
  }
  return chosen;
}

function nothingDue(state: StudyState, now: Date): RoundPlan {
  const upcoming = [...state.cards.values()]
    .filter((p) => !p.suspended)
    .map((p) => p.fsrs.due.getTime())
    .filter((t) => t > now.getTime())
    .sort((a, b) => a - b)[0];
  return {
    kind: 'nothing-due',
    nextDueAt: upcoming === undefined ? null : new Date(upcoming),
    pendingCards: [...state.cards.values()].filter((p) =>
      isPending(p, now, state.curriculum.settings),
    ).length,
  };
}

function toRoundCard(state: StudyState, p: CardProgress): RoundCard {
  const topic = state.curriculum.bySlug.get(p.card.topic);
  return {
    id: p.card.id,
    topicTitle: topic?.title ?? p.card.topic,
    notePath: topic === undefined ? '' : notePathFor(topic),
    lesson: p.card.lesson,
    question: p.card.question,
    answer: p.card.answer,
    isNew: p.fsrs.state === State.New,
  };
}

/** One card as it was asked: what grading needs, without the question-plan-only fields. */
export type AskedCard = Readonly<{
  id: CardId;
  topicTitle: string;
  lesson: number;
  question: string;
  answer: string;
  graded: boolean;
}>;

export type AskedRound = Readonly<{
  round: RoundId;
  askedAt: Date;
  cards: readonly AskedCard[];
}>;

export type RoundViewError =
  | Readonly<{ kind: 'no-rounds' }>
  | Readonly<{ kind: 'unknown-round'; round: string }>
  | Readonly<{ kind: 'no-grades'; round: RoundId }>;

/** The round asked most recently, or null when none has been. */
export function lastAsked(state: StudyState): AskedRound | null {
  const latest = latestRound(state.rounds);
  if (latest === null) return null;
  return {
    round: latest.round,
    askedAt: latest.at,
    cards: latest.cards.map((id) => askedCard(state, id, latest.round)),
  };
}

function latestRound(
  rounds: StudyState['rounds'],
): Readonly<{ round: RoundId; at: Date; cards: readonly CardId[] }> | null {
  let latest: Readonly<{ round: RoundId; at: Date; cards: readonly CardId[] }> | null = null;
  for (const [round, asked] of rounds)
    if (latest === null || asked.at > latest.at)
      latest = { round, at: asked.at, cards: asked.cards };
  return latest;
}

function askedCard(state: StudyState, id: CardId, round: RoundId): AskedCard {
  const progress = state.cards.get(id);
  const card = progress?.card;
  return {
    id,
    topicTitle:
      card === undefined ? '' : (state.curriculum.bySlug.get(card.topic)?.title ?? card.topic),
    lesson: card?.lesson ?? 0,
    question: card?.question ?? '',
    answer: card?.answer ?? '',
    graded: progress?.grades.some((g) => g.round === round) === true,
  };
}

/** One graded answer, numbered by the position the card held in the round it was asked. */
export type GradedAnswer = Readonly<{
  position: number;
  topicTitle: string;
  lesson: number;
  answer: string;
  grade: Grade;
  nextDueAt: Date;
}>;

/**
 * The graded cards of a round in asked order; an ungraded card is omitted and leaves its
 * number behind, so a number the learner is told to override always means the same card.
 * A round with no grade at all is an error, not an empty message: nothing suppresses a
 * reply, so the sentinel would reach the learner as the word ALL_CLEAR.
 */
export function gradedRound(
  state: StudyState,
  roundSlug: string,
): Result<readonly GradedAnswer[], RoundViewError> {
  const latest = lastAsked(state);
  const id = roundSlug === 'last' ? (latest?.round ?? null) : (roundSlug as RoundId);
  if (id === null) return err({ kind: 'no-rounds' });
  const round = state.rounds.get(id);
  if (round === undefined) return err({ kind: 'unknown-round', round: roundSlug });

  const items: GradedAnswer[] = [];
  round.cards.forEach((cardId, i) => {
    const progress = state.cards.get(cardId);
    const graded = progress?.grades.find((g) => g.round === id);
    if (progress === undefined || graded === undefined) return;
    items.push({
      position: i + 1,
      topicTitle: state.curriculum.bySlug.get(progress.card.topic)?.title ?? progress.card.topic,
      lesson: progress.card.lesson,
      answer: progress.card.answer,
      grade: graded.grade,
      nextDueAt: progress.fsrs.due,
    });
  });
  if (items.length === 0) return err({ kind: 'no-grades', round: id });
  return ok(items);
}

export type GradeError =
  | Readonly<{ kind: 'unknown-round'; round: string }>
  | Readonly<{ kind: 'unknown-card'; card: string }>
  | Readonly<{ kind: 'card-not-in-round'; card: CardId; round: RoundId }>;

export type GradeOutcome = Readonly<{
  event: StudyEvent;
  /** True when this replaces an earlier grade for the same card in the same round. */
  override: boolean;
  nextDueAt: Date;
  intervalDays: number;
}>;

export function gradeCard(
  state: StudyState,
  cmd: Readonly<{ round: string; card: string; grade: Grade; answer?: string }>,
  now: Date,
): Result<GradeOutcome, GradeError> {
  const round = state.rounds.get(cmd.round as RoundId);
  if (round === undefined) return err({ kind: 'unknown-round', round: cmd.round });
  const progress = state.cards.get(cmd.card as CardId);
  if (progress === undefined) return err({ kind: 'unknown-card', card: cmd.card });
  const roundId = cmd.round as RoundId;
  if (!round.cards.includes(progress.card.id))
    return err({ kind: 'card-not-in-round', card: progress.card.id, round: roundId });

  const prior = progress.grades.find((g) => g.round === roundId);
  const record: GradeRecord = { round: roundId, at: prior?.at ?? now, grade: cmd.grade };
  const grades = [...progress.grades.filter((g) => g.round !== roundId), record].sort(
    (a, b) => a.at.getTime() - b.at.getTime(),
  );
  const due = scheduleCard(state.curriculum.settings, progress.unlockedAt, grades).due;
  return ok({
    event: {
      kind: 'card-graded',
      at: now.toISOString(),
      round: roundId,
      card: progress.card.id,
      grade: cmd.grade,
      ...(cmd.answer !== undefined ? { answer: cmd.answer } : {}),
    },
    override: prior !== undefined,
    nextDueAt: due,
    intervalDays: Math.max(0, Math.round(((due.getTime() - now.getTime()) / DAY_MS) * 10) / 10),
  });
}

export type SuspendError = Readonly<{ kind: 'unknown-card'; card: string }>;

/** Suspend (`reason` given) or unsuspend (`reason` null) a card — e.g. a badly written one. */
export function setSuspended(
  state: StudyState,
  card: string,
  reason: string | null,
  now: Date,
): Result<StudyEvent, SuspendError> {
  if (!cardExists(state, card)) return err({ kind: 'unknown-card', card });
  const id = card as CardId;
  return ok(
    reason === null
      ? { kind: 'card-unsuspended', at: now.toISOString(), card: id }
      : { kind: 'card-suspended', at: now.toISOString(), card: id, reason },
  );
}

const cardExists = (state: StudyState, card: string): boolean =>
  [...state.notes.values()].some((n) => n.cards.some((c) => c.id === card));

// ─── Building ─────────────────────────────────────────────────────────────────

export type BuildPlan =
  | Readonly<{
      kind: 'build';
      topic: Topic;
      notePath: string;
      /** Built prerequisite notes, to link and to avoid re-teaching. */
      prereqNotes: readonly Readonly<{ slug: TopicSlug; title: string; notePath: string }>[];
      /**
       * Material tagged to this topic, the oldest batch first (see `oldestBatch`): extra sources
       * for the research. Signals beyond the batch stay pending and reach the note through a
       * refresh once it is built.
       */
      signals: readonly SignalNoted[];
      /**
       * The newest instant among `signals` (null when there are none). The builder records it
       * with `learn signals-reviewed --through`: everything up to it was shown, so it is not
       * offered again, and anything newer, including a signal that arrives during the run,
       * stays pending.
       */
      signalsThrough: string | null;
      unreadAhead: number;
    }>
  | Readonly<{ kind: 'buffer-full'; unreadAhead: number }>
  | Readonly<{ kind: 'all-built' }>;

/** Keep `buildBuffer` built-but-unread topics ahead of the reader, building in study order. */
export function nextBuild(state: StudyState): BuildPlan {
  const isBuilt = (slug: TopicSlug) => state.notes.has(slug) || state.brokenNotes.has(slug);
  const unreadAhead = state.curriculum.topics.filter(
    (t) => isBuilt(t.slug) && !isFullyRead(state, t.slug),
  ).length;
  const target = state.curriculum.topics.find((t) => !isBuilt(t.slug));
  if (target === undefined) return { kind: 'all-built' };
  if (unreadAhead >= state.curriculum.settings.buildBuffer)
    return { kind: 'buffer-full', unreadAhead };
  const batch = oldestBatch(unreviewedSignals(state, target.slug, new Date(0)));
  return {
    kind: 'build',
    topic: target,
    notePath: notePathFor(target),
    prereqNotes: target.prereqs.flatMap((slug) => {
      const t = state.curriculum.bySlug.get(slug);
      const note = state.notes.get(slug);
      return t !== undefined && note !== undefined
        ? [{ slug, title: note.title, notePath: notePathFor(t) }]
        : [];
    }),
    signals: batch?.signals ?? [],
    signalsThrough: batch?.through ?? null,
    unreadAhead,
  };
}

/**
 * A topic's signals no build or refresh has reviewed, oldest first: those after the last
 * review's instant, or, with none recorded, after `baseline`.
 */
export function unreviewedSignals(
  state: StudyState,
  topic: TopicSlug,
  baseline: Date,
): readonly SignalNoted[] {
  return signalsAfter(state.signals, topic, state.signalsReviewedThrough.get(topic) ?? baseline);
}

// ─── Feynman ──────────────────────────────────────────────────────────────────

export type FeynmanPlan =
  | Readonly<{
      kind: 'feynman';
      topic: Topic;
      notePath: string;
      /** Mean recall probability across the topic's reviewed cards, 0–1 (null if none). */
      meanRetrievability: number | null;
      weakestCards: readonly Readonly<{ id: CardId; question: string }>[];
    }>
  | Readonly<{ kind: 'none-eligible' }>;

/** The fully-read, off-cooldown topic you currently remember worst. */
export function pickFeynman(state: StudyState, now: Date): FeynmanPlan {
  const settings = state.curriculum.settings;
  const scheduler = schedulerFor(settings);
  const cooldown = settings.feynmanCooldownDays * DAY_MS;
  const ranked = state.curriculum.topics
    .filter((t) => isFullyRead(state, t.slug))
    .filter((t) => {
      const last = state.feynmanAt.get(t.slug);
      return last === undefined || now.getTime() - last.getTime() >= cooldown;
    })
    .map((topic) => {
      const reviewed = [...state.cards.values()]
        .filter((p) => p.card.topic === topic.slug && p.fsrs.state !== State.New)
        .map((p) => ({ p, r: scheduler.get_retrievability(p.fsrs, now, false) }))
        .sort((a, b) => a.r - b.r);
      const mean =
        reviewed.length === 0 ? null : reviewed.reduce((s, x) => s + x.r, 0) / reviewed.length;
      return { topic, mean, weakest: reviewed.slice(0, 3).map(({ p }) => p.card) };
    })
    .sort((a, b) => (a.mean ?? 1) - (b.mean ?? 1) || a.topic.position - b.topic.position);
  const pick = ranked[0];
  if (pick === undefined) return { kind: 'none-eligible' };
  return {
    kind: 'feynman',
    topic: pick.topic,
    notePath: notePathFor(pick.topic),
    meanRetrievability: pick.mean === null ? null : Math.round(pick.mean * 100) / 100,
    weakestCards: pick.weakest.map((c) => ({ id: c.id, question: c.question })),
  };
}

export type FeynmanError = Readonly<{ kind: 'not-fully-read'; topic: string }>;

export function logFeynman(
  state: StudyState,
  topic: string,
  gaps: readonly string[],
  now: Date,
): Result<StudyEvent, FeynmanError> {
  if (!isFullyRead(state, topic as TopicSlug)) return err({ kind: 'not-fully-read', topic });
  return ok({ kind: 'feynman-checked', at: now.toISOString(), topic: topic as TopicSlug, gaps });
}

// ─── Summary ──────────────────────────────────────────────────────────────────

export type StudySummary = Readonly<{
  topics: Readonly<{ total: number; built: number; fullyRead: number; broken: number }>;
  cards: Readonly<{
    unlocked: number;
    due: number;
    new: number;
    mature: number;
    suspended: number;
  }>;
  last7Days: Readonly<{ lessonsRead: number; reviews: number; recallRate: number | null }>;
  last30Days: Readonly<{ reviews: number; recallRate: number | null }>;
  feynmanChecks: number;
  orphanEvents: number;
}>;

/** "Mature" = stability ≥ 21 days, the conventional SRS threshold for long-term retention. */
const MATURE_STABILITY_DAYS = 21;

export function summarize(state: StudyState, now: Date): StudySummary {
  const all = [...state.cards.values()];
  const grades = all.flatMap((p) => p.grades);
  const window = (days: number) => {
    const inWindow = grades.filter((g) => now.getTime() - g.at.getTime() < days * DAY_MS);
    const recalled = inWindow.filter((g) => g.grade !== 'again').length;
    return {
      reviews: inWindow.length,
      recallRate:
        inWindow.length === 0 ? null : Math.round((recalled / inWindow.length) * 100) / 100,
    };
  };
  const topics = state.curriculum.topics;
  return {
    topics: {
      total: topics.length,
      built: topics.filter((t) => state.notes.has(t.slug)).length,
      fullyRead: topics.filter((t) => isFullyRead(state, t.slug)).length,
      broken: state.brokenNotes.size,
    },
    cards: {
      unlocked: all.length,
      due: countDue(state, now),
      new: all.filter((p) => p.fsrs.state === State.New).length,
      mature: all.filter((p) => p.fsrs.stability >= MATURE_STABILITY_DAYS).length,
      suspended: all.filter((p) => p.suspended).length,
    },
    last7Days: {
      lessonsRead: [...state.lessonsRead.values()].filter(
        (at) => now.getTime() - at.getTime() < 7 * DAY_MS,
      ).length,
      ...window(7),
    },
    last30Days: window(30),
    feynmanChecks: state.feynmanAt.size,
    orphanEvents: state.orphanEvents,
  };
}
