// ─── Learn Command ────────────────────────────────────────────────────────────
//
// Shell orchestrator behind `scripts/learn.ts`, the single command surface the
// learning skills (learn-lesson, learn-recall, learn-feynman, curriculum-builder) use.
// Every command is: load (port) → parse + fold (pure) → decide (pure) → append the
// returned events (port) → print. The model never edits schedule state directly: it
// calls these commands, and the core decides what is legal.
//
// Two output shapes, and the difference is the point. `json` is data for a skill to read;
// `text` is the finished Telegram message, rendered by code (`--message`, `round-result`)
// so the model relays it verbatim instead of composing it. Models for judgment (grading an
// answer), code for authority and for formatting.

import { match } from 'ts-pattern';
import {
  type Curriculum,
  type TopicSlug,
  notePathFor,
  parseCurriculum,
} from '../core/curriculum.js';
import {
  renderLessonMessage,
  renderRoundMessage,
  renderRoundResult,
} from '../core/learning-messages.js';
import type { BasenameIndex, LearningVault } from '../core/learning-vault-port.js';
import { type MasterNote, lessonSection, parseMasterNote } from '../core/master-note.js';
import { ALL_CLEAR } from '../core/scheduled-output.js';
import {
  type SourceRepairError,
  type VaultScope,
  applySourceRepair,
  planSourceRepair,
  scopeKey,
  scopeOf,
  uniquePaths,
} from '../core/source-repair.js';
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
  type RoundViewError,
  type StudyState,
  foldStudy,
  gradeCard,
  gradedRound,
  lastAsked,
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
  lesson [--message]                       next lesson to read (--message: the Telegram text)
  read <topic-slug> <lesson>               mark a lesson read → unlocks its cards
  section <topic-slug> <lesson>            one lesson's text and its cards (reply payload)
  round [--size N] [--message]             pick + record a recall round (--message: questions only)
  last-round                               the round just asked, with its reference answers
  round-result <round|last>                the graded round, rendered for the learner
  grade <round> <card-id> <again|hard|good|easy> [--answer TEXT]
  suspend <card-id> <reason...>            stop asking a (bad) card
  unsuspend <card-id>
  build-next                               next topic for the curriculum builder
  fix-sources [--apply]                    re-point renamed sources (--apply writes the registry)
  feynman                                  pick this week's explain-it-back topic
  feynman-log <topic-slug> [--gaps "gap one; gap two"]
  validate [--sources] [--slug S]            check registry, notes, log (+ source paths)`;

/** What a command prints: data for a skill, or the finished message for the learner. */
export type LearnOutput =
  | Readonly<{ kind: 'json'; value: unknown }>
  | Readonly<{ kind: 'text'; text: string }>;

const json = (value: unknown): LearnOutput => ({ kind: 'json', value });
const text = (rendered: string): LearnOutput => ({ kind: 'text', text: rendered });

type Command =
  | { kind: 'status' }
  | { kind: 'lesson'; message: boolean }
  | { kind: 'read'; topic: string; lesson: number }
  | { kind: 'section'; topic: string; lesson: number }
  | { kind: 'round'; size: number | undefined; message: boolean }
  | { kind: 'last-round' }
  | { kind: 'round-result'; round: string }
  | { kind: 'grade'; round: string; card: string; grade: Grade; answer: string | undefined }
  | { kind: 'suspend'; card: string; reason: string }
  | { kind: 'unsuspend'; card: string }
  | { kind: 'build-next' }
  | { kind: 'fix-sources'; apply: boolean }
  | { kind: 'feynman' }
  | { kind: 'feynman-log'; topic: string; gaps: readonly string[] }
  | { kind: 'validate'; sources: boolean; slug: string | undefined };

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

const isGrade = (s: string | undefined): s is Grade => GRADES.some((g) => g === s);

const lessonPositional = (
  args: readonly string[],
): Result<{ topic: string; lesson: number }, string> => {
  const topic = args[1];
  const lesson = Number(args[2]);
  if (topic === undefined || !Number.isInteger(lesson) || lesson < 1)
    return err(`${args[0]} <topic-slug> <lesson-number>`);
  return ok({ topic, lesson });
};

type CommandName = Command['kind'];

/**
 * One argv parser per command name, each given the full argv (name first). The mapped
 * type is the totality proof: a new Command variant without a parser is a compile error.
 */
const COMMAND_PARSERS: {
  readonly [K in CommandName]: (args: readonly string[]) => Result<Command, string>;
} = {
  status: () => ok({ kind: 'status' }),
  lesson: (args) => ok({ kind: 'lesson', message: args.includes('--message') }),
  'build-next': () => ok({ kind: 'build-next' }),
  feynman: () => ok({ kind: 'feynman' }),
  'fix-sources': (args) => ok({ kind: 'fix-sources', apply: args.includes('--apply') }),
  read: (args) => {
    const parsed = lessonPositional(args);
    return parsed.ok ? ok({ kind: 'read', ...parsed.value }) : err(parsed.error);
  },
  section: (args) => {
    const parsed = lessonPositional(args);
    return parsed.ok ? ok({ kind: 'section', ...parsed.value }) : err(parsed.error);
  },
  round: (args) => {
    const raw = flag(args, '--size');
    const size = raw === undefined ? undefined : Number(raw);
    if (size !== undefined && (!Number.isInteger(size) || size < 1 || size > 10))
      return err('round --size must be an integer 1–10');
    return ok({ kind: 'round', size, message: args.includes('--message') });
  },
  'last-round': () => ok({ kind: 'last-round' }),
  'round-result': ([, round]) =>
    round === undefined ? err('round-result <round-id|last>') : ok({ kind: 'round-result', round }),
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
  validate: (args) =>
    ok({ kind: 'validate', sources: args.includes('--sources'), slug: flag(args, '--slug') }),
};

const isCommandName = (s: string | undefined): s is CommandName =>
  s !== undefined && Object.hasOwn(COMMAND_PARSERS, s);

/** Parse argv (after the script name) into a command. */
export function parseLearnArgs(args: readonly string[]): Result<Command, string> {
  const name = args[0];
  return isCommandName(name) ? COMMAND_PARSERS[name](args) : err(LEARN_USAGE);
}

type Loaded = Readonly<{
  registryText: string;
  curriculum: Curriculum;
  state: StudyState;
  noteErrors: ReadonlyMap<TopicSlug, readonly string[]>;
  logErrors: readonly string[];
}>;

async function load(vault: LearningVault): Promise<Result<Loaded, readonly string[]>> {
  const registryText = await vault.readRegistry();
  const curriculum = parseCurriculum(registryText);
  if (!curriculum.ok) return err(curriculum.error);

  const notes = new Map<TopicSlug, MasterNote>();
  const broken = new Map<TopicSlug, readonly string[]>();
  const texts = await Promise.all(
    curriculum.value.topics.map(async (t) => [t, await vault.readNote(notePathFor(t))] as const),
  );
  for (const [topic, note] of texts) {
    if (note === null) continue;
    const parsed = parseMasterNote(note, topic.slug);
    if (parsed.ok) notes.set(topic.slug, parsed.value);
    else broken.set(topic.slug, parsed.error);
  }

  const log = parseStudyLog(await vault.readLog());
  // An unparseable log folds as empty here only so `validate` can report it; runLearnCommand
  // refuses every other command while logErrors is non-empty (never act on partial history).
  const events: readonly StudyEvent[] = log.ok ? log.value : [];
  return ok({
    registryText,
    curriculum: curriculum.value,
    state: foldStudy(curriculum.value, notes, broken, events),
    noteErrors: broken,
    logErrors: log.ok ? [] : log.error,
  });
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/**
 * Run one learn command. `ok` carries data to print — JSON, or the finished message text
 * for a `--message` command. `err` carries a message for stderr (non-zero exit). Writes
 * happen only after every check has passed.
 */
export async function runLearnCommand(
  args: readonly string[],
  vault: LearningVault,
  now: Date,
): Promise<Result<LearnOutput, string>> {
  const command = parseLearnArgs(args);
  if (!command.ok) return err(command.error);

  const loaded = await load(vault);
  if (!loaded.ok) return err(`curriculum registry invalid:\n- ${loaded.error.join('\n- ')}`);
  const { state, logErrors } = loaded.value;
  if (logErrors.length > 0 && command.value.kind !== 'validate')
    return err(`study log is corrupt — fix it before continuing:\n- ${logErrors.join('\n- ')}`);

  const session: Session = {
    state,
    curriculum: loaded.value.curriculum,
    now,
    append: (events) => vault.appendLog(events.map(serializeEvent)),
  };

  return match(command.value)
    .with({ kind: 'status' }, async () => ok(json(summarize(state, now))))
    .with({ kind: 'lesson' }, (c) => runLesson(c, session))
    .with({ kind: 'read' }, (c) => runRead(c, session))
    .with({ kind: 'section' }, (c) => runSection(c, session))
    .with({ kind: 'round' }, (c) => runRound(c, session))
    .with({ kind: 'last-round' }, async () => ok(json(lastRoundView(state))))
    .with({ kind: 'round-result' }, (c) => runRoundResult(c, session))
    .with({ kind: 'grade' }, (c) => runGrade(c, session))
    .with({ kind: 'suspend' }, { kind: 'unsuspend' }, (c) => runSuspend(c, session))
    .with({ kind: 'build-next' }, async () => ok(json(buildView(nextBuild(state)))))
    .with({ kind: 'fix-sources' }, (c) => runFixSources(c, loaded.value, vault))
    .with({ kind: 'feynman' }, async () => ok(json(feynmanView(pickFeynman(state, now)))))
    .with({ kind: 'feynman-log' }, (c) => runFeynmanLog(c, session))
    .with({ kind: 'validate' }, (c) => runValidate(c, loaded.value, vault))
    .exhaustive();
}

// ─── Commands that decide, then append ────────────────────────────────────────

/** What a deciding command works on: folded state, the curriculum, the clock, the writer. */
type Session = Readonly<{
  state: StudyState;
  curriculum: Curriculum;
  now: Date;
  append: (events: readonly StudyEvent[]) => Promise<void>;
}>;

type CommandOf<K extends CommandName> = Extract<Command, { kind: K }>;
type CommandResult = Promise<Result<LearnOutput, string>>;

/** The lesson plan as data, or as the message the learner receives. */
async function runLesson(c: CommandOf<'lesson'>, { state, now }: Session): CommandResult {
  const plan = nextLesson(state, now);
  return ok(c.message ? text(renderLessonMessage(plan)) : json(lessonView(plan)));
}

/** One lesson's text and its cards: the payload for pretest replies and follow-ups. */
async function runSection(c: CommandOf<'section'>, { state, curriculum }: Session) {
  const topic = curriculum.bySlug.get(c.topic as TopicSlug);
  if (topic === undefined) return err(`unknown topic "${c.topic}"`);
  const note = state.notes.get(topic.slug);
  if (note === undefined) return err(`topic "${c.topic}" has no master note yet`);
  const section = lessonSection(note, c.lesson);
  if (!section.ok)
    return err(
      `topic "${c.topic}" has lessons 1–${section.error.lessonCount}, not ${section.error.lesson}`,
    );
  return ok(
    json({
      kind: 'section',
      topic: topic.slug,
      topicTitle: note.title,
      notePath: notePathFor(topic),
      lesson: section.value.number,
      lessonTitle: section.value.title,
      body: section.value.body,
      cards: note.cards
        .filter((card) => card.lesson === c.lesson)
        .map((card) => ({ id: card.id, question: card.question, answer: card.answer })),
    }),
  );
}

async function runRead(c: CommandOf<'read'>, { state, now, append }: Session): CommandResult {
  const result = markLessonRead(state, c.topic, c.lesson, now);
  if (!result.ok) return err(readErrorMessage(result.error));
  if (result.value.kind === 'already-read') return ok(json({ kind: 'already-read' }));
  await append([result.value.event]);
  return ok(json({ kind: 'recorded', unlockedCards: result.value.unlockedCards }));
}

async function runRound(c: CommandOf<'round'>, { state, now, append }: Session): CommandResult {
  const plan = pickRound(state, now, c.size);
  if (plan.kind === 'nothing-due')
    return ok(
      c.message
        ? text(ALL_CLEAR)
        : json({
            kind: plan.kind,
            nextDueAt: iso(plan.nextDueAt),
            pendingCards: plan.pendingCards,
          }),
    );
  await append([plan.event]);
  return ok(
    c.message
      ? text(renderRoundMessage(plan))
      : json({ kind: plan.kind, round: plan.round, cards: plan.cards }),
  );
}

/** The graded round, numbered in the order it was asked; a round with no grade is refused. */
async function runRoundResult(
  c: CommandOf<'round-result'>,
  { state, now }: Session,
): CommandResult {
  const items = gradedRound(state, c.round);
  if (!items.ok) return err(roundViewError(items.error));
  return ok(text(renderRoundResult(items.value, now)));
}

function roundViewError(error: RoundViewError): string {
  return match(error)
    .with({ kind: 'no-rounds' }, () => 'no round has been asked yet')
    .with({ kind: 'unknown-round' }, (e) => `unknown round "${e.round}"`)
    .with(
      { kind: 'no-grades' },
      (e) => `round "${e.round}" has no graded card yet — grade at least one, then ask again`,
    )
    .exhaustive();
}

/** The round just asked, with every card's reference answer: the grader's whole input. */
function lastRoundView(state: StudyState): unknown {
  const round = lastAsked(state);
  if (round === null) return { kind: 'no-round' };
  return {
    kind: 'last-round',
    round: round.round,
    askedAt: round.askedAt.toISOString(),
    cards: round.cards,
  };
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
  return ok(
    json({
      kind: 'graded',
      card: c.card,
      grade: c.grade,
      override: result.value.override,
      nextDueAt: iso(result.value.nextDueAt),
      intervalDays: result.value.intervalDays,
    }),
  );
}

async function runSuspend(
  c: CommandOf<'suspend' | 'unsuspend'>,
  { state, now, append }: Session,
): CommandResult {
  const result = setSuspended(state, c.card, c.kind === 'suspend' ? c.reason : null, now);
  if (!result.ok) return err(`unknown card "${result.error.card}"`);
  await append([result.value]);
  return ok(json({ kind: result.value.kind, card: c.card }));
}

async function runFeynmanLog(
  c: CommandOf<'feynman-log'>,
  { state, now, append }: Session,
): CommandResult {
  const result = logFeynman(state, c.topic, c.gaps, now);
  if (!result.ok) return err(`topic "${result.error.topic}" is not fully read`);
  await append([result.value]);
  return ok(json({ kind: 'recorded', topic: c.topic, gaps: c.gaps.length }));
}

// ─── Source repair ────────────────────────────────────────────────────────────

/** Every declared source path, with its existence and same-name candidates, then the plan. */
async function runFixSources(
  c: CommandOf<'fix-sources'>,
  { registryText, curriculum }: Loaded,
  vault: LearningVault,
): CommandResult {
  const declared = uniquePaths(curriculum.topics.flatMap((t) => t.sources));
  const existing = new Set<string>();
  for (const path of declared) if (await vault.sourceExists(path)) existing.add(path);
  const missing = declared.filter((path) => !existing.has(path));

  const scopes = new Map<string, VaultScope>();
  for (const path of missing) {
    const scope = scopeOf(path);
    if (scope !== null) scopes.set(scopeKey(scope), scope);
  }
  const indexes = new Map<string, BasenameIndex>();
  for (const [key, scope] of scopes) indexes.set(key, await vault.indexByBasename(scope));

  // A rename planned from a tree that could not be fully listed is a guess: refuse instead.
  const unreadable = uniquePaths([...indexes.values()].flatMap((i) => i.unreadable));
  if (unreadable.length > 0)
    return err(
      `cannot plan a repair — these roots could not be listed, so a rename would be guessed:\n- ${unreadable.join('\n- ')}`,
    );

  const plan = planSourceRepair(
    curriculum,
    existing,
    (scope) => indexes.get(scopeKey(scope))?.byName ?? new Map(),
  );
  const report = {
    checked: plan.checked,
    resolved: plan.resolved,
    fixes: plan.fixes,
    ambiguous: plan.ambiguous,
    unresolved: plan.unresolved,
    unscoped: plan.unscoped,
  };
  if (!c.apply || plan.fixes.length === 0)
    return ok(json({ kind: 'source-repair', applied: 0, ...report }));

  const rewritten = applySourceRepair(registryText, plan);
  if (!rewritten.ok) return err(sourceRepairErrorMessage(rewritten.error));
  const reparsed = parseCurriculum(rewritten.value.text);
  if (!reparsed.ok)
    return err(`repair would break the registry:\n- ${reparsed.error.join('\n- ')}`);
  await vault.writeRegistry(rewritten.value.text);

  const remaining: string[] = [];
  for (const path of uniquePaths(reparsed.value.topics.flatMap((t) => t.sources)))
    if (!(await vault.sourceExists(path))) remaining.push(path);
  return ok(
    json({ kind: 'source-repair', applied: rewritten.value.applied, remaining, ...report }),
  );
}

function sourceRepairErrorMessage(error: SourceRepairError): string {
  return match(error)
    .with({ kind: 'registry-unparseable' }, (e) => `registry YAML parse error: ${e.reason}`)
    .with({ kind: 'no-topics' }, () => 'registry has no topics sequence')
    .with({ kind: 'unknown-topic' }, (e) => `topic "${e.topic}" not found in the registry`)
    .with({ kind: 'no-sources' }, (e) => `topic "${e.topic}" has no sources sequence`)
    .with(
      { kind: 'declaration-absent' },
      (e) =>
        `topic "${e.topic}" declares neither "${e.from}" nor its target — the registry changed since the plan`,
    )
    .exhaustive();
}

/**
 * Report every registry, note and log problem; with `--sources`, also missing source files.
 * `--slug` narrows it to one topic — the builder checks only the note it just wrote, so a
 * pre-existing broken note elsewhere does not block it.
 */
async function runValidate(
  c: CommandOf<'validate'>,
  { curriculum, state, noteErrors, logErrors }: Loaded,
  vault: LearningVault,
): CommandResult {
  const topics =
    c.slug === undefined ? curriculum.topics : curriculum.topics.filter((t) => t.slug === c.slug);
  if (topics.length === 0) return err(`unknown topic "${c.slug ?? ''}"`);
  const inScope = new Set(topics.map((t) => t.slug));

  const missingSources: string[] = [];
  if (c.sources)
    for (const topic of topics)
      for (const source of topic.sources)
        if (!(await vault.sourceExists(source))) missingSources.push(`${topic.slug}: ${source}`);
  const scopedNoteErrors = Object.fromEntries(
    [...noteErrors].filter(([slug]) => inScope.has(slug)),
  );
  const notes = [...state.notes.values()].filter((note) => inScope.has(note.topic));
  const valid =
    Object.keys(scopedNoteErrors).length === 0 &&
    logErrors.length === 0 &&
    missingSources.length === 0;
  return ok(
    json({
      kind: 'validation',
      valid,
      slug: c.slug ?? null,
      topics: topics.length,
      builtNotes: notes.length,
      cards: notes.reduce((n, note) => n + note.cards.length, 0),
      noteErrors: scopedNoteErrors,
      logErrors,
      orphanEvents: state.orphanEvents,
      ...(c.sources ? { missingSources } : {}),
    }),
  );
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
