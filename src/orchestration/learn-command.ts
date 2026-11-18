// ─── Learn Command ────────────────────────────────────────────────────────────
//
// Shell orchestrator behind `scripts/learn.ts`, the single command surface the
// learning skills (learn-lesson, learn-recall, learn-feynman, curriculum-builder) use.
// Every command is: load (port) → parse + fold (pure) → decide (pure) → append the
// returned events (port) → print JSON. The model never edits schedule state directly:
// it calls these commands, and the core decides what is legal. Models for judgment
// (grading an answer), code for authority (what that grade does to the schedule).

import { match } from 'ts-pattern';
import {
  type Curriculum,
  type TopicSlug,
  notePathFor,
  parseCurriculum,
} from '../core/curriculum.js';
import type { LearningVault } from '../core/learning-vault-port.js';
import { type MasterNote, parseMasterNote } from '../core/master-note.js';
import {
  GRADES,
  type Grade,
  MAX_ANSWER_CHARS,
  type StudyEvent,
  parseStudyLog,
  serializeEvent,
} from '../core/study-log.js';
import {
  type BuildPlan,
  type FeynmanPlan,
  type GradeError,
  type LessonPlan,
  type ReadError,
  type StudyState,
  foldStudy,
  gradeCard,
  logFeynman,
  markLessonRead,
  nextBuild,
  nextLesson,
  pickFeynman,
  pickRound,
  setSuspended,
  summarize,
} from '../core/study-plan.js';
import { type Result, err, ok } from '../core/types.js';

export const LEARN_USAGE = `usage: learn <command>
  status                                   progress summary
  lesson                                   next lesson to read (no state change)
  read <topic-slug> <lesson>               mark a lesson read → unlocks its cards
  round [--size N]                         pick + record a recall round
  grade <round> <card-id> <again|hard|good|easy> [--answer TEXT]
  suspend <card-id> <reason...>            stop asking a (bad) card
  unsuspend <card-id>
  build-next                               next topic for the curriculum builder
  feynman                                  pick this week's explain-it-back topic
  feynman-log <topic-slug> [--gaps "gap one; gap two"]
  validate [--sources]                     check registry, notes, log (+ source paths)`;

type Command =
  | { kind: 'status' }
  | { kind: 'lesson' }
  | { kind: 'read'; topic: string; lesson: number }
  | { kind: 'round'; size: number | undefined }
  | { kind: 'grade'; round: string; card: string; grade: Grade; answer: string | undefined }
  | { kind: 'suspend'; card: string; reason: string }
  | { kind: 'unsuspend'; card: string }
  | { kind: 'build-next' }
  | { kind: 'feynman' }
  | { kind: 'feynman-log'; topic: string; gaps: readonly string[] }
  | { kind: 'validate'; sources: boolean };

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

const isGrade = (s: string | undefined): s is Grade => GRADES.some((g) => g === s);

type CommandName = Command['kind'];

/**
 * One argv parser per command name, each given the full argv (name first). The mapped
 * type is the totality proof: a new Command variant without a parser is a compile error.
 */
const COMMAND_PARSERS: {
  readonly [K in CommandName]: (args: readonly string[]) => Result<Command, string>;
} = {
  status: () => ok({ kind: 'status' }),
  lesson: () => ok({ kind: 'lesson' }),
  'build-next': () => ok({ kind: 'build-next' }),
  feynman: () => ok({ kind: 'feynman' }),
  read: ([, topic, rawLesson]) => {
    const lesson = Number(rawLesson);
    if (topic === undefined || !Number.isInteger(lesson) || lesson < 1)
      return err('read <topic-slug> <lesson-number>');
    return ok({ kind: 'read', topic, lesson });
  },
  round: (args) => {
    const raw = flag(args, '--size');
    const size = raw === undefined ? undefined : Number(raw);
    if (size !== undefined && (!Number.isInteger(size) || size < 1 || size > 10))
      return err('round --size must be an integer 1–10');
    return ok({ kind: 'round', size });
  },
  grade: (args) => {
    const [, round, card, grade] = args;
    if (round === undefined || card === undefined || !isGrade(grade))
      return err(`grade <round> <card-id> <${GRADES.join('|')}> [--answer TEXT]`);
    const answer = flag(args, '--answer');
    return ok({ kind: 'grade', round, card, grade, answer: answer?.slice(0, MAX_ANSWER_CHARS) });
  },
  suspend: (args) => {
    const card = args[1];
    const reason = args.slice(2).join(' ').trim();
    if (card === undefined || reason === '') return err('suspend <card-id> <reason...>');
    return ok({ kind: 'suspend', card, reason });
  },
  unsuspend: ([, card]) =>
    card === undefined ? err('unsuspend <card-id>') : ok({ kind: 'unsuspend', card }),
  'feynman-log': (args) => {
    const topic = args[1];
    if (topic === undefined) return err('feynman-log <topic-slug> [--gaps "a; b"]');
    const gaps = (flag(args, '--gaps') ?? '')
      .split(';')
      .map((g) => g.trim())
      .filter((g) => g !== '');
    return ok({ kind: 'feynman-log', topic, gaps });
  },
  validate: (args) => ok({ kind: 'validate', sources: args.includes('--sources') }),
};

const isCommandName = (s: string | undefined): s is CommandName =>
  s !== undefined && Object.hasOwn(COMMAND_PARSERS, s);

/** Parse argv (after the script name) into a command. */
export function parseLearnArgs(args: readonly string[]): Result<Command, string> {
  const name = args[0];
  return isCommandName(name) ? COMMAND_PARSERS[name](args) : err(LEARN_USAGE);
}

type Loaded = Readonly<{
  curriculum: Curriculum;
  state: StudyState;
  noteErrors: ReadonlyMap<TopicSlug, readonly string[]>;
  logErrors: readonly string[];
}>;

async function load(vault: LearningVault): Promise<Result<Loaded, readonly string[]>> {
  const curriculum = parseCurriculum(await vault.readRegistry());
  if (!curriculum.ok) return err(curriculum.error);

  const notes = new Map<TopicSlug, MasterNote>();
  const broken = new Map<TopicSlug, readonly string[]>();
  const texts = await Promise.all(
    curriculum.value.topics.map(async (t) => [t, await vault.readNote(notePathFor(t))] as const),
  );
  for (const [topic, text] of texts) {
    if (text === null) continue;
    const parsed = parseMasterNote(text, topic.slug);
    if (parsed.ok) notes.set(topic.slug, parsed.value);
    else broken.set(topic.slug, parsed.error);
  }

  const log = parseStudyLog(await vault.readLog());
  // An unparseable log folds as empty here only so `validate` can report it; runLearnCommand
  // refuses every other command while logErrors is non-empty (never act on partial history).
  const events: readonly StudyEvent[] = log.ok ? log.value : [];
  return ok({
    curriculum: curriculum.value,
    state: foldStudy(curriculum.value, notes, broken, events),
    noteErrors: broken,
    logErrors: log.ok ? [] : log.error,
  });
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/**
 * Run one learn command. `ok` carries the JSON object to print; `err` carries a message
 * for stderr (non-zero exit). Writes happen only after every check has passed.
 */
export async function runLearnCommand(
  args: readonly string[],
  vault: LearningVault,
  now: Date,
): Promise<Result<unknown, string>> {
  const command = parseLearnArgs(args);
  if (!command.ok) return err(command.error);

  const loaded = await load(vault);
  if (!loaded.ok) return err(`curriculum registry invalid:\n- ${loaded.error.join('\n- ')}`);
  const { state, logErrors } = loaded.value;
  if (logErrors.length > 0 && command.value.kind !== 'validate')
    return err(`study log is corrupt — fix it before continuing:\n- ${logErrors.join('\n- ')}`);

  const session: Session = {
    state,
    now,
    append: (events) => vault.appendLog(events.map(serializeEvent)),
  };

  return match(command.value)
    .with({ kind: 'status' }, async () => ok(summarize(state, now)))
    .with({ kind: 'lesson' }, async () => ok(lessonView(nextLesson(state, now))))
    .with({ kind: 'read' }, (c) => runRead(c, session))
    .with({ kind: 'round' }, (c) => runRound(c, session))
    .with({ kind: 'grade' }, (c) => runGrade(c, session))
    .with({ kind: 'suspend' }, { kind: 'unsuspend' }, (c) => runSuspend(c, session))
    .with({ kind: 'build-next' }, async () => ok(buildView(nextBuild(state))))
    .with({ kind: 'feynman' }, async () => ok(feynmanView(pickFeynman(state, now))))
    .with({ kind: 'feynman-log' }, (c) => runFeynmanLog(c, session))
    .with({ kind: 'validate' }, (c) => runValidate(c, loaded.value, vault))
    .exhaustive();
}

// ─── Commands that decide, then append ────────────────────────────────────────

/** What a deciding command works on: the folded state, the clock, and the log writer. */
type Session = Readonly<{
  state: StudyState;
  now: Date;
  append: (events: readonly StudyEvent[]) => Promise<void>;
}>;

type CommandOf<K extends CommandName> = Extract<Command, { kind: K }>;
type CommandResult = Promise<Result<unknown, string>>;

async function runRead(c: CommandOf<'read'>, { state, now, append }: Session): CommandResult {
  const result = markLessonRead(state, c.topic, c.lesson, now);
  if (!result.ok) return err(readErrorMessage(result.error));
  if (result.value.kind === 'already-read') return ok({ kind: 'already-read' });
  await append([result.value.event]);
  return ok({ kind: 'recorded', unlockedCards: result.value.unlockedCards });
}

async function runRound(c: CommandOf<'round'>, { state, now, append }: Session): CommandResult {
  const plan = pickRound(state, now, c.size);
  if (plan.kind === 'nothing-due')
    return ok({
      kind: plan.kind,
      nextDueAt: iso(plan.nextDueAt),
      pendingCards: plan.pendingCards,
    });
  await append([plan.event]);
  return ok({ kind: plan.kind, round: plan.round, cards: plan.cards });
}

async function runGrade(c: CommandOf<'grade'>, { state, now, append }: Session): CommandResult {
  const result = gradeCard(
    state,
    {
      round: c.round,
      card: c.card,
      grade: c.grade,
      ...(c.answer !== undefined ? { answer: c.answer } : {}),
    },
    now,
  );
  if (!result.ok) return err(gradeErrorMessage(result.error));
  await append([result.value.event]);
  return ok({
    kind: 'graded',
    card: c.card,
    grade: c.grade,
    override: result.value.override,
    nextDueAt: iso(result.value.nextDueAt),
    intervalDays: result.value.intervalDays,
  });
}

async function runSuspend(
  c: CommandOf<'suspend' | 'unsuspend'>,
  { state, now, append }: Session,
): CommandResult {
  const result = setSuspended(state, c.card, c.kind === 'suspend' ? c.reason : null, now);
  if (!result.ok) return err(`unknown card "${result.error.card}"`);
  await append([result.value]);
  return ok({ kind: result.value.kind, card: c.card });
}

async function runFeynmanLog(
  c: CommandOf<'feynman-log'>,
  { state, now, append }: Session,
): CommandResult {
  const result = logFeynman(state, c.topic, c.gaps, now);
  if (!result.ok) return err(`topic "${result.error.topic}" is not fully read`);
  await append([result.value]);
  return ok({ kind: 'recorded', topic: c.topic, gaps: c.gaps.length });
}

/** Report every registry, note and log problem; with `--sources`, also missing source files. */
async function runValidate(
  c: CommandOf<'validate'>,
  { curriculum, state, noteErrors, logErrors }: Loaded,
  vault: LearningVault,
): CommandResult {
  const missingSources: string[] = [];
  if (c.sources)
    for (const topic of curriculum.topics)
      for (const source of topic.sources)
        if (!(await vault.sourceExists(source))) missingSources.push(`${topic.slug}: ${source}`);
  const valid = noteErrors.size === 0 && logErrors.length === 0 && missingSources.length === 0;
  return ok({
    kind: 'validation',
    valid,
    topics: curriculum.topics.length,
    builtNotes: state.notes.size,
    cards: [...state.notes.values()].reduce((n, note) => n + note.cards.length, 0),
    noteErrors: Object.fromEntries(noteErrors),
    logErrors,
    orphanEvents: state.orphanEvents,
    ...(c.sources ? { missingSources } : {}),
  });
}

// ─── Views (pure) ─────────────────────────────────────────────────────────────

function lessonView(plan: LessonPlan): unknown {
  return match(plan)
    .with({ kind: 'lesson' }, (p) => ({
      kind: p.kind,
      topic: p.topic.slug,
      topicTitle: p.noteTitle,
      outcome: p.topic.outcome,
      notePath: p.notePath,
      lesson: p.lesson.number,
      lessonTitle: p.lesson.title,
      lessonCount: p.lessonCount,
      minutes: p.minutesPerLesson,
      pretest: p.lesson.pretest,
      dueCards: p.dueCards,
      backlogHigh: p.backlogHigh,
      readCommand: `read ${p.topic.slug} ${p.lesson.number}`,
    }))
    .with({ kind: 'awaiting-build' }, (p) => ({
      kind: p.kind,
      topic: p.topic.slug,
      topicTitle: p.topic.title,
    }))
    .with({ kind: 'note-invalid' }, (p) => ({
      kind: p.kind,
      topic: p.topic.slug,
      errors: p.errors,
    }))
    .with({ kind: 'curriculum-complete' }, (p) => p)
    .exhaustive();
}

function buildView(plan: BuildPlan): unknown {
  return match(plan)
    .with({ kind: 'build' }, (p) => ({
      kind: p.kind,
      topic: p.topic,
      notePath: p.notePath,
      prereqNotes: p.prereqNotes,
      unreadAhead: p.unreadAhead,
    }))
    .with({ kind: 'buffer-full' }, { kind: 'all-built' }, (p) => p)
    .exhaustive();
}

function feynmanView(plan: FeynmanPlan): unknown {
  return plan.kind === 'feynman'
    ? { ...plan, topic: plan.topic.slug, topicTitle: plan.topic.title }
    : plan;
}

function readErrorMessage(error: ReadError): string {
  return match(error)
    .with({ kind: 'unknown-topic' }, (e) => `unknown topic "${e.topic}"`)
    .with({ kind: 'not-built' }, (e) => `topic "${e.topic}" has no master note yet`)
    .with(
      { kind: 'unknown-lesson' },
      (e) => `topic "${e.topic}" has lessons 1–${e.lessonCount}, not ${e.lesson}`,
    )
    .exhaustive();
}

function gradeErrorMessage(error: GradeError): string {
  return match(error)
    .with({ kind: 'unknown-round' }, (e) => `unknown round "${e.round}"`)
    .with({ kind: 'unknown-card' }, (e) => `unknown or locked card "${e.card}"`)
    .with(
      { kind: 'card-not-in-round' },
      (e) => `card "${e.card}" was not asked in round "${e.round}"`,
    )
    .exhaustive();
}
