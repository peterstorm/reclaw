import { describe, expect, it } from 'vitest';
import { fakeVault, notePath, renderNote, renderRegistry } from '../core/__fixtures__/learning.js';
import { REGISTRY_PATH } from '../core/curriculum.js';
import { ALL_CLEAR } from '../core/scheduled-output.js';
import { parseLearnArgs, runLearnCommand } from './learn-command.js';

const T0 = new Date('2026-10-17T07:00:00.000Z');
const at = (h: number) => new Date(T0.getTime() + h * 3_600_000);

const registry = renderRegistry([
  { slug: 'a', sources: ['learning/curriculum/registry.yaml', 'missing/note.md'] },
  { slug: 'b', prereqs: ['a'] },
]);
const vaultWith = (
  notes: Record<string, string> = { [notePath('a')]: renderNote({ slug: 'a', lessons: 2 }) },
  log = '',
) => fakeVault(registry, notes, log);

type Vault = ReturnType<typeof vaultWith>;

async function output(vault: Vault, args: string[], now = T0) {
  const result = await runLearnCommand(args, vault, now);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

/** The JSON a command prints; a `--message` command never gets here. */
async function run(vault: Vault, args: string[], now = T0): Promise<Record<string, unknown>> {
  const value = await output(vault, args, now);
  if (value.kind !== 'json') throw new Error(`expected json, got ${value.kind}`);
  return value.value as Record<string, unknown>;
}

/** The finished Telegram text a `--message` command (or `round-result`) prints. */
async function runText(vault: Vault, args: string[], now = T0): Promise<string> {
  const value = await output(vault, args, now);
  if (value.kind !== 'text') throw new Error(`expected text, got ${value.kind}`);
  return value.text;
}

describe('learn command — end to end over a fake vault', () => {
  it('lesson → read → round → grade → status', async () => {
    const vault = vaultWith();
    const lesson = await run(vault, ['lesson']);
    expect(lesson).toMatchObject({
      kind: 'lesson',
      topic: 'a',
      lesson: 1,
      readCommand: 'read a 1',
      minutes: 12,
    });
    expect(vault.log()).toBe('');

    expect(await run(vault, ['read', 'a', '1'])).toEqual({ kind: 'recorded', unlockedCards: 3 });
    expect(await run(vault, ['read', 'a', '1'])).toEqual({ kind: 'already-read' });

    const round = await run(vault, ['round', '--size', '2'], at(1));
    expect(round).toMatchObject({ kind: 'round' });
    const cards = round.cards as { id: string; answer: string }[];
    expect(cards.map((c) => c.id)).toEqual(['a/c01', 'a/c02']);
    expect(cards[0]?.answer).toBe('Answer 1.');

    const graded = await run(
      vault,
      ['grade', String(round.round), 'a/c01', 'good', '--answer', 'my words'],
      at(1),
    );
    expect(graded).toMatchObject({ kind: 'graded', override: false });
    expect(vault.log()).toContain('"answer":"my words"');

    const status = await run(vault, ['status'], at(2));
    expect(status).toMatchObject({
      cards: { unlocked: 3 },
      last7Days: { reviews: 1, lessonsRead: 1 },
    });
  });

  it('renders the lesson message in code, so the skill relays instead of composing', async () => {
    const message = await runText(vaultWith(), ['lesson', '--message']);
    expect(message).toContain("📖 **Today's lesson** — Note a, lesson 1/2");
    expect(message).toContain('1. Pretest 1a?');
    expect(message).toContain('Swipe-reply **done**');
    // The JSON form still exists, for a skill that needs fields rather than text.
    expect(await run(vaultWith(), ['lesson'])).toMatchObject({ kind: 'lesson', topic: 'a' });
  });

  it('renders the round questions without answers, then the graded round', async () => {
    const vault = vaultWith();
    await run(vault, ['read', 'a', '1']);
    await run(vault, ['read', 'a', '2']);

    const questions = await runText(vault, ['round', '--size', '2', '--message']);
    expect(questions).toContain('🧠 **Recall** — 2 question(s)');
    expect(questions).toContain('**1.** Question 1?');
    expect(questions).not.toContain('Answer 1.');
    expect(vault.log()).toContain('"kind":"round-asked"');

    const round = JSON.parse(vault.log().trim().split('\n').at(-1) ?? '{}') as { round: string };
    const asked = await run(vault, ['last-round']);
    expect(asked).toMatchObject({ kind: 'last-round', round: round.round });
    expect(asked.cards).toEqual([
      {
        id: 'a/c01',
        topicTitle: 'Title of a',
        lesson: 1,
        question: 'Question 1?',
        answer: 'Answer 1.',
        graded: false,
      },
      expect.objectContaining({ id: 'a/c02', answer: 'Answer 2.', graded: false }),
    ]);
    await run(vault, ['grade', round.round, 'a/c01', 'again', '--answer', 'no idea'], at(1));
    await run(vault, ['grade', round.round, 'a/c02', 'good', '--answer', 'my words'], at(1));

    const result = await runText(vault, ['round-result', 'last'], at(1));
    expect(result).toContain('**1. again ✗** — Answer 1.');
    expect(result).toContain('Re-read: Title of a, Lesson 1.');
    expect(result).toContain('**2. good ✓** — Answer 2.');
    expect(result).toMatch(/Next up: (now|in \d+[mhd])\./);

    // Nothing is due before a lesson is read: the round says ALL_CLEAR, which the runtime suppresses.
    expect(await runText(vaultWith(), ['round', '--message'], at(2))).toBe(ALL_CLEAR);
    expect(await run(vaultWith(), ['last-round'])).toEqual({ kind: 'no-round' });
  });

  it('serves one lesson and its cards as the reply payload', async () => {
    const section = await run(vaultWith(), ['section', 'a', '2']);
    expect(section).toMatchObject({
      kind: 'section',
      topic: 'a',
      lesson: 2,
      lessonTitle: 'Part 2',
    });
    expect(String(section.body)).toContain('Body of lesson 2.');
    expect(String(section.body)).not.toContain('Body of lesson 1.');
    expect((section.cards as { id: string }[]).map((c) => c.id)).toEqual([
      'a/c04',
      'a/c05',
      'a/c06',
    ]);
    expect(await runLearnCommand(['section', 'a', '9'], vaultWith(), T0)).toMatchObject({
      ok: false,
      error: expect.stringContaining('has lessons 1–2, not 9'),
    });
  });

  it('writes nothing when a command is refused', async () => {
    const vault = vaultWith();
    const refused = await runLearnCommand(['grade', 'r-x', 'a/c01', 'good'], vault, T0);
    expect(refused).toMatchObject({ ok: false });
    expect(vault.log()).toBe('');
    expect(await runLearnCommand(['read', 'b', '1'], vault, T0)).toMatchObject({
      ok: false,
      error: expect.stringContaining('no master note'),
    });
  });

  it('refuses to act on a corrupt study log, but validate still reports it', async () => {
    const vault = vaultWith(undefined, 'garbage\n');
    expect(await runLearnCommand(['round'], vault, T0)).toMatchObject({
      ok: false,
      error: expect.stringContaining('corrupt'),
    });
    expect(await run(vault, ['validate'])).toMatchObject({
      valid: false,
      logErrors: [expect.stringContaining('line 1')],
    });
  });

  it('validate reports broken notes and, on request, missing source paths', async () => {
    const vault = vaultWith({
      [notePath('a')]: renderNote({ slug: 'a', lessons: 1, cardsPerLesson: 6 }),
    });
    const report = await run(vault, ['validate', '--sources']);
    expect(report).toMatchObject({
      valid: false,
      builtNotes: 0,
      missingSources: ['a: missing/note.md'],
    });
    expect(Object.keys(report.noteErrors as object)).toEqual(['a']);
  });

  it('validate --slug checks only the note the builder just wrote', async () => {
    const vault = fakeVault(registry, {
      [notePath('a')]: renderNote({ slug: 'a', lessons: 2 }),
      [notePath('b')]: renderNote({ slug: 'b', lessons: 1, cardsPerLesson: 6 }),
    });
    const global = await run(vault, ['validate']);
    expect(global).toMatchObject({ valid: false, topics: 2, builtNotes: 1 });

    const scoped = await run(vault, ['validate', '--sources', '--slug', 'a']);
    expect(scoped).toMatchObject({
      slug: 'a',
      topics: 1,
      builtNotes: 1,
      noteErrors: {},
      missingSources: ['a: missing/note.md'],
    });
    expect(await runLearnCommand(['validate', '--slug', 'zzz'], vault, T0)).toMatchObject({
      ok: false,
      error: expect.stringContaining('unknown topic'),
    });

    // The builder's gate: one broken note elsewhere must not block the note just written.
    const clean = fakeVault(
      renderRegistry([{ slug: 'a', sources: [REGISTRY_PATH] }, { slug: 'b' }]),
      {
        [notePath('a')]: renderNote({ slug: 'a', lessons: 2 }),
        [notePath('b')]: renderNote({ slug: 'b', lessons: 1, cardsPerLesson: 6 }),
      },
    );
    expect(await run(clean, ['validate', '--sources', '--slug', 'a'])).toMatchObject({
      valid: true,
      topics: 1,
    });
  });

  it('celebrates the end of the curriculum instead of printing the sentinel', async () => {
    const only = renderRegistry([{ slug: 'a' }]);
    const vault = fakeVault(only, { [notePath('a')]: renderNote({ slug: 'a', lessons: 2 }) });
    await run(vault, ['read', 'a', '1']);
    await run(vault, ['read', 'a', '2']);
    const message = await runText(vault, ['lesson', '--message']);
    expect(message).not.toBe(ALL_CLEAR);
    expect(message).toContain('Curriculum complete');
  });

  it('build-next proposes the next unbuilt topic with its registry entry', async () => {
    expect(await run(vaultWith(), ['build-next'])).toMatchObject({
      kind: 'build',
      topic: { slug: 'b', prereqs: ['a'] },
      notePath: 'learning/curriculum/ai/b.md',
      prereqNotes: [{ slug: 'a' }],
    });
  });

  it('suspend / unsuspend / feynman round-trip through the log', async () => {
    const vault = vaultWith();
    await run(vault, ['read', 'a', '1']);
    await run(vault, ['read', 'a', '2']);
    expect(await run(vault, ['suspend', 'a/c02', 'too', 'vague'])).toEqual({
      kind: 'card-suspended',
      card: 'a/c02',
    });
    expect(await run(vault, ['unsuspend', 'a/c02'])).toEqual({
      kind: 'card-unsuspended',
      card: 'a/c02',
    });
    expect(await run(vault, ['feynman'])).toMatchObject({ kind: 'feynman', topic: 'a' });
    expect(await run(vault, ['feynman-log', 'a', '--gaps', 'one; two'])).toEqual({
      kind: 'recorded',
      topic: 'a',
      gaps: 2,
    });
  });
});

describe('round-result', () => {
  it('refuses a round with nothing graded instead of printing the suppression sentinel', async () => {
    const vault = vaultWith();
    await run(vault, ['read', 'a', '1']);
    const asked = await run(vault, ['round', '--size', '2'], at(1));

    const refused = await runLearnCommand(['round-result', 'last'], vault, at(1));
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining('no graded card') });
    expect(refused.ok ? '' : refused.error).not.toContain(ALL_CLEAR);

    // The primary form names the round; grading one card makes the same round render.
    const round = String(asked.round);
    const card = (asked.cards as { id: string }[])[0]?.id ?? '';
    await run(vault, ['grade', round, card, 'good'], at(1));
    expect(await runText(vault, ['round-result', round], at(1))).toContain('**1. good ✓**');

    expect(await runLearnCommand(['round-result', 'r-nope'], vault, at(1))).toMatchObject({
      ok: false,
      error: expect.stringContaining('unknown round'),
    });
    expect(await runLearnCommand(['round-result', 'last'], vaultWith(), at(1))).toMatchObject({
      ok: false,
      error: expect.stringContaining('no round has been asked'),
    });
  });
});

describe('signals — new material tagged to topics', () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    topics: ['b'],
    ref: 'https://eugeneyan.com/writing/public-evals/?utm_source=rss',
    source: 'Eugene Yan',
    title: 'Public agent evals are broken',
    takeaway: 'Report pass^k next to the mean; run a do-nothing control.',
    ...over,
  });
  const submit = (vault: Vault, items: readonly unknown[], now = T0) =>
    run(vault, ['signal', JSON.stringify(items)], now);

  it('records new items once, however often the same batch is submitted', async () => {
    const vault = vaultWith();
    const batch = [entry(), entry({ topics: ['a', 'b'], ref: 'media/instagram/h/abc.md' })];

    expect(await submit(vault, batch)).toEqual({
      kind: 'signals-recorded',
      recorded: 3,
      duplicates: 0,
      rejected: [],
    });
    const written = vault.log();
    expect(written.trim().split('\n')).toHaveLength(3);
    expect(written).toContain('"ref":"https://eugeneyan.com/writing/public-evals/"');

    expect(await submit(vault, batch, at(1))).toMatchObject({ recorded: 0, duplicates: 3 });
    expect(vault.log()).toBe(written);
  });

  it('reports bad items by index, records the good ones and writes nothing for the bad', async () => {
    const vault = vaultWith();
    const result = await submit(vault, [
      entry(),
      entry({ topics: ['ghost'] }),
      entry({ ref: 'ftp://nope', topics: ['a'] }),
    ]);
    expect(result).toMatchObject({
      recorded: 1,
      rejected: [
        { index: 1, reason: 'unknown topic "ghost"' },
        { index: 2, reason: expect.stringContaining('ftp://nope') },
      ],
    });
    expect(vault.log().trim().split('\n')).toHaveLength(1);
  });

  it('refuses a submission that is not a JSON array, and writes nothing', async () => {
    const vault = vaultWith();
    for (const bad of ['nope', '{}', '[]']) {
      expect(await runLearnCommand(['signal', bad], vault, T0)).toMatchObject({
        ok: false,
        error: expect.stringContaining('signal batch'),
      });
    }
    expect(vault.log()).toBe('');
  });

  it('hands the builder the target topic’s signals, oldest first, and no one else’s', async () => {
    const vault = vaultWith();
    await submit(vault, [entry({ ref: 'https://example.com/old', title: 'Old' })], T0);
    await submit(vault, [entry({ ref: 'https://example.com/new', title: 'New' })], at(24));
    await submit(vault, [entry({ topics: ['a'], ref: 'https://example.com/other' })], at(25));

    const next = await run(vault, ['build-next'], at(26));
    expect(next).toMatchObject({
      kind: 'build',
      topic: { slug: 'b' },
      signalsThrough: at(24).toISOString(),
    });
    const signals = next.signals as { ref: string; title: string; takeaway: string }[];
    expect(signals.map((s) => s.title)).toEqual(['Old', 'New']);
    expect(signals[0]).toEqual({
      at: T0.toISOString(),
      source: 'Eugene Yan',
      title: 'Old',
      ref: 'https://example.com/old',
      takeaway: 'Report pass^k next to the mean; run a do-nothing control.',
    });
  });

  it('lists every topic with its built flag and signal count, and one topic’s signals', async () => {
    const vault = vaultWith();
    await submit(vault, [entry(), entry({ ref: 'https://example.com/2' })]);

    expect(await run(vault, ['topics'])).toEqual({
      kind: 'topics',
      topics: [
        {
          slug: 'a',
          title: 'Title of a',
          subdomain: 'core',
          built: true,
          signals: 0,
          pendingReview: 0,
        },
        {
          slug: 'b',
          title: 'Title of b',
          subdomain: 'core',
          built: false,
          signals: 2,
          pendingReview: 2,
        },
      ],
    });
    expect(await run(vault, ['signals'])).toMatchObject({ kind: 'topics' });
    const one = await run(vault, ['signals', 'b']);
    expect(one).toMatchObject({ kind: 'signals', topic: 'b' });
    expect(one.signals).toHaveLength(2);
    expect(await runLearnCommand(['signals', 'zzz'], vault, T0)).toMatchObject({
      ok: false,
      error: expect.stringContaining('unknown topic'),
    });
  });

  it('counts a signal for a topic that left the registry as an orphan, not as material', async () => {
    const orphan = `${JSON.stringify({
      kind: 'signal-noted',
      at: T0.toISOString(),
      topic: 'ghost',
      ref: 'https://example.com/x',
      source: 's',
      title: 't',
      takeaway: 'k',
    })}\n`;
    const vault = vaultWith(undefined, orphan);
    expect(await run(vault, ['status'])).toMatchObject({ orphanEvents: 1 });
    expect(await run(vault, ['build-next'])).toMatchObject({ signals: [] });
  });

  it('never disturbs the study state: a signal neither unlocks nor schedules a card', async () => {
    const vault = vaultWith();
    const before = await run(vault, ['status'], at(1));
    await submit(vault, [entry({ topics: ['a'] })]);
    expect(await run(vault, ['status'], at(1))).toEqual(before);
  });

  it('refuses to record on a corrupt study log', async () => {
    const vault = vaultWith(undefined, 'garbage\n');
    expect(await runLearnCommand(['signal', JSON.stringify([entry()])], vault, T0)).toMatchObject({
      ok: false,
      error: expect.stringContaining('corrupt'),
    });
    expect(vault.log()).toBe('garbage\n');
  });
});

describe('refresh — built notes pick up later signals', () => {
  const dated = renderNote({ slug: 'a', lessons: 2, sourcesChecked: '2026-10-01' });
  const vaultAt = (note: string = dated, log = '') =>
    fakeVault(registry, { [notePath('a')]: note }, log);
  const tag = (vault: Vault, ref: string, now: Date) =>
    run(
      vault,
      [
        'signal',
        JSON.stringify([
          {
            topics: ['a'],
            ref,
            source: 'Example',
            title: ref,
            takeaway: 'Says a thing.',
          },
        ]),
      ],
      now,
    );

  it('has nothing to refresh until enough signals are pending', async () => {
    const vault = vaultAt();
    expect(await run(vault, ['refresh-next'])).toEqual({ kind: 'nothing-to-refresh' });
    await tag(vault, 'https://example.com/1', at(1));
    expect(await run(vault, ['refresh-next'], at(2))).toEqual({ kind: 'nothing-to-refresh' });
    await tag(vault, 'https://example.com/2', at(3));
    expect(await run(vault, ['refresh-next'], at(4))).toMatchObject({
      kind: 'refresh',
      topic: 'a',
      notePath: 'learning/curriculum/ai/a.md',
      sourcesChecked: '2026-10-01',
      pending: 2,
      lessonCount: 2,
      lessonsRead: 0,
      signalsThrough: at(3).toISOString(),
    });
  });

  it('a recorded review clears what it covered and leaves later signals pending', async () => {
    const vault = vaultAt();
    await tag(vault, 'https://example.com/1', at(1));
    await tag(vault, 'https://example.com/2', at(2));
    const plan = await run(vault, ['refresh-next'], at(3));

    // A signal that lands while the builder works is newer than `through`, so it stays pending.
    await tag(vault, 'https://example.com/3', at(4));
    const done = await run(
      vault,
      [
        'signals-reviewed',
        'a',
        '--through',
        String(plan.signalsThrough),
        '--used',
        '1',
        '--expect',
        String(plan.fingerprint),
      ],
      at(5),
    );
    expect(done).toMatchObject({ kind: 'signals-reviewed', topic: 'a', used: 1 });
    expect(await run(vault, ['topics'], at(5))).toMatchObject({
      topics: [
        expect.objectContaining({ slug: 'a', signals: 3, pendingReview: 1 }),
        expect.anything(),
      ],
    });
    expect(await run(vault, ['refresh-next'], at(5))).toEqual({ kind: 'nothing-to-refresh' });

    await tag(vault, 'https://example.com/4', at(6));
    expect(await run(vault, ['refresh-next'], at(7))).toMatchObject({
      kind: 'refresh',
      pending: 2,
    });
  });

  it('accepts a note refreshed the permitted way: updates, sources_checked, nothing else', async () => {
    const vault = vaultAt();
    await tag(vault, 'https://example.com/1', at(1));
    await tag(vault, 'https://example.com/2', at(2));
    const plan = await run(vault, ['refresh-next'], at(3));

    const refreshed = fakeVault(
      registry,
      {
        [notePath('a')]: renderNote({
          slug: 'a',
          lessons: 2,
          sourcesChecked: '2026-11-25',
          updates: '- **2026-11-25** A newer number. [Page](https://example.com/1)',
        }),
      },
      vault.log(),
    );
    expect(
      await run(
        refreshed,
        [
          'signals-reviewed',
          'a',
          '--through',
          String(plan.signalsThrough),
          '--expect',
          String(plan.fingerprint),
        ],
        at(4),
      ),
    ).toMatchObject({ kind: 'signals-reviewed' });
  });

  it('refuses, and records nothing, when the refresh touched a lesson', async () => {
    const vault = vaultAt();
    await tag(vault, 'https://example.com/1', at(1));
    await tag(vault, 'https://example.com/2', at(2));
    const plan = await run(vault, ['refresh-next'], at(3));
    const before = vault.log();

    const tampered = fakeVault(
      registry,
      {
        [notePath('a')]: renderNote({
          slug: 'a',
          lessons: 2,
          sourcesChecked: '2026-10-01',
          lessonOneExtra: 'A rewritten paragraph.',
        }),
      },
      before,
    );
    const refused = await runLearnCommand(
      [
        'signals-reviewed',
        'a',
        '--through',
        String(plan.signalsThrough),
        '--expect',
        String(plan.fingerprint),
      ],
      tampered,
      at(4),
    );
    expect(refused).toMatchObject({
      ok: false,
      error: expect.stringContaining('lessons or cards changed'),
    });
    expect(tampered.log()).toBe(before);
    // Still pending: the refresh will be offered again.
    expect(await run(tampered, ['refresh-next'], at(5))).toMatchObject({
      kind: 'refresh',
      pending: 2,
    });
  });

  // Why the skill bumps `sources_checked` only AFTER the review is recorded: until a review exists
  // that date is the baseline, so bumping it first and dying leaves signals older than the new
  // date looking reviewed. This pins the hazard the ordering rule exists for.
  it('treats a bumped sources_checked as the new baseline while no review is recorded', async () => {
    const vault = vaultAt();
    await tag(vault, 'https://example.com/1', at(1));
    await tag(vault, 'https://example.com/2', at(2));
    expect(await run(vault, ['refresh-next'], at(3))).toMatchObject({ kind: 'refresh' });

    const bumpedFirst = fakeVault(
      registry,
      { [notePath('a')]: renderNote({ slug: 'a', lessons: 2, sourcesChecked: '2026-12-01' }) },
      vault.log(),
    );
    expect(await run(bumpedFirst, ['refresh-next'], at(4))).toEqual({ kind: 'nothing-to-refresh' });
  });

  it('leaves a fully read note alone, and an unbuilt topic to the builder', async () => {
    const vault = vaultAt();
    await tag(vault, 'https://example.com/1', at(1));
    await tag(vault, 'https://example.com/2', at(2));
    await run(vault, ['read', 'a', '1'], at(3));
    await run(vault, ['read', 'a', '2'], at(3));
    expect(await run(vault, ['refresh-next'], at(4))).toEqual({ kind: 'nothing-to-refresh' });
  });

  it('after a build, review covers what the builder was shown and nothing newer', async () => {
    const vault = vaultWith();
    const body = (ref: string) => [{ topics: ['b'], ref, source: 'S', title: 'T', takeaway: 'K' }];
    await run(vault, ['signal', JSON.stringify(body('https://example.com/1'))], at(1));
    const next = await run(vault, ['build-next'], at(2));
    expect(next).toMatchObject({
      kind: 'build',
      topic: { slug: 'b' },
      signalsThrough: at(1).toISOString(),
    });
    await run(vault, ['signal', JSON.stringify(body('https://example.com/2'))], at(3));

    // The builder writes the note, then records its review through the instant it was shown.
    const built = fakeVault(
      registry,
      {
        [notePath('a')]: renderNote({ slug: 'a', lessons: 2 }),
        [notePath('b')]: renderNote({ slug: 'b', lessons: 2, sourcesChecked: '2026-10-17' }),
      },
      vault.log(),
    );
    await run(
      built,
      ['signals-reviewed', 'b', '--through', String(next.signalsThrough), '--used', '1', '--built'],
      at(4),
    );
    expect(await run(built, ['topics'], at(4))).toMatchObject({
      topics: [
        expect.anything(),
        expect.objectContaining({ slug: 'b', signals: 2, pendingReview: 1 }),
      ],
    });
  });

  // A build offers the oldest batch, never the newest: whatever does not fit is not lost, it is
  // pending for the first refresh of the note once it is built. And a run of equal instants (one
  // submission) is never cut, or the review "through" that instant would swallow its tail.
  describe('more signals than one batch', () => {
    const tagMany = async (vault: Vault, count: number, spread: boolean) => {
      for (let i = 0; i < count; i++)
        await run(
          vault,
          [
            'signal',
            JSON.stringify([
              {
                topics: ['b'],
                ref: `https://example.com/${i}`,
                source: 'S',
                title: `T${i}`,
                takeaway: 'K',
              },
            ]),
          ],
          at(spread ? i + 1 : 1),
        );
    };
    const builtB = (vault: Vault) =>
      fakeVault(
        registry,
        {
          [notePath('a')]: renderNote({ slug: 'a', lessons: 2 }),
          [notePath('b')]: renderNote({ slug: 'b', lessons: 2, sourcesChecked: '2026-10-17' }),
        },
        vault.log(),
      );

    it('builds with the oldest 25, then leaves the rest for a refresh of the built note', async () => {
      const vault = vaultWith();
      await tagMany(vault, 30, true);
      const next = await run(vault, ['build-next'], at(40));
      const shown = next.signals as { title: string }[];
      expect(shown).toHaveLength(25);
      expect(shown[0]?.title).toBe('T0');
      expect(shown.at(-1)?.title).toBe('T24');
      expect(next.signalsThrough).toBe(at(25).toISOString());

      const built = builtB(vault);
      await run(
        built,
        [
          'signals-reviewed',
          'b',
          '--through',
          String(next.signalsThrough),
          '--used',
          '3',
          '--built',
        ],
        at(41),
      );
      const refresh = await run(built, ['refresh-next'], at(42));
      expect(refresh).toMatchObject({ kind: 'refresh', topic: 'b', pending: 5 });
      expect((refresh.signals as { title: string }[]).map((s) => s.title)).toEqual([
        'T25',
        'T26',
        'T27',
        'T28',
        'T29',
      ]);
    });

    it('keeps 30 signals of one instant whole instead of cutting at 25', async () => {
      const vault = vaultWith();
      await tagMany(vault, 30, false);
      const next = await run(vault, ['build-next'], at(40));
      expect(next.signals).toHaveLength(30);
      const built = builtB(vault);
      await run(
        built,
        [
          'signals-reviewed',
          'b',
          '--through',
          String(next.signalsThrough),
          '--used',
          '1',
          '--built',
        ],
        at(41),
      );
      expect(await run(built, ['refresh-next'], at(42))).toEqual({ kind: 'nothing-to-refresh' });
      expect(await run(built, ['topics'], at(42))).toMatchObject({
        topics: [expect.anything(), expect.objectContaining({ slug: 'b', pendingReview: 0 })],
      });
    });
  });

  it('refuses a review it cannot stand behind', async () => {
    const vault = vaultAt();
    await tag(vault, 'https://example.com/1', at(1));
    const written = vault.log();
    const at1 = at(1).toISOString();
    for (const args of [
      // Neither flag, or both: a build and a refresh are different operations.
      ['signals-reviewed', 'a', '--through', at1],
      ['signals-reviewed', 'a', '--through', at1, '--built', '--expect', 'deadbeef'],
      ['signals-reviewed', 'a', '--through', 'yesterday', '--built'],
      // An instant that is not that of a signal on record (the mark only moves forward).
      ['signals-reviewed', 'a', '--through', at(99).toISOString(), '--built'],
      ['signals-reviewed', 'a', '--through', at(0).toISOString(), '--built'],
      // More signals used than exist up to it.
      ['signals-reviewed', 'a', '--through', at1, '--used', '2', '--built'],
      ['signals-reviewed', 'a', '--through', at1, '--used', '-1', '--built'],
      ['signals-reviewed', 'b', '--through', at1, '--built'],
      ['signals-reviewed', 'zzz', '--through', at1, '--built'],
      ['signals-reviewed', 'a'],
    ])
      expect((await runLearnCommand(args, vault, at(2))).ok, args.join(' ')).toBe(false);
    expect(vault.log()).toBe(written);
  });
});

describe('fix-sources', () => {
  const moved = renderRegistry([{ slug: 'a', sources: ['old/source.md', 'nowhere/gone.md'] }]);
  const build = () =>
    fakeVault(moved, {
      'new/source.md': '# moved\n',
      [notePath('a')]: renderNote({ slug: 'a', lessons: 2 }),
    });

  it('proposes a rename it can prove and leaves the rest for a human', async () => {
    const vault = build();
    const plan = await run(vault, ['fix-sources']);
    expect(plan).toMatchObject({
      kind: 'source-repair',
      applied: 0,
      checked: 2,
      fixes: [{ topic: 'a', from: 'old/source.md', to: 'new/source.md' }],
      unresolved: [{ topic: 'a', from: 'nowhere/gone.md' }],
    });
    expect(vault.registry()).toBe(moved);
  });

  it('applies only with --apply, then is idempotent', async () => {
    const vault = build();
    const applied = await run(vault, ['fix-sources', '--apply']);
    expect(applied).toMatchObject({ applied: 1, remaining: ['nowhere/gone.md'] });
    expect(vault.registry()).toContain('new/source.md');
    expect(vault.registry()).not.toContain('old/source.md');

    const once = vault.registry();
    const again = await run(vault, ['fix-sources', '--apply']);
    expect(again).toMatchObject({ applied: 0 });
    expect(vault.registry()).toBe(once);
  });

  // A rename planned from a tree nobody could fully list is a guess. Refuse, and write nothing.
  it('refuses to plan when a root could not be listed', async () => {
    const vault = build();
    const partial = {
      ...vault,
      indexByBasename: async () => ({
        byName: new Map([['source.md', ['new/source.md']]]),
        unreadable: ['.'],
      }),
    };
    const refused = await runLearnCommand(['fix-sources', '--apply'], partial, T0);
    expect(refused).toMatchObject({
      ok: false,
      error: expect.stringContaining('could not be listed'),
    });
    expect(vault.registry()).toBe(moved);
  });

  it('reports an absolute declaration as unscoped and never matches it by name', async () => {
    const withAbsolute = fakeVault(renderRegistry([{ slug: 'a', sources: ['/etc/hosts.md'] }]), {
      'somewhere/hosts.md': '# same name\n',
    });
    expect(await run(withAbsolute, ['fix-sources'])).toMatchObject({
      fixes: [],
      unscoped: [{ topic: 'a', from: '/etc/hosts.md' }],
    });
  });

  // The plan's §6 case: an ambiguous declaration is reported AND leaves the registry alone,
  // while the provable rename in the same run is applied.
  it('applies the provable rename and leaves the ambiguous line byte-identical', async () => {
    const text = renderRegistry([{ slug: 'a', sources: ['old/source.md', 'dup/twin.md'] }]);
    const vault = fakeVault(text, {
      'new/source.md': '# moved\n',
      'one/twin.md': '# one\n',
      'two/twin.md': '# two\n',
    });
    const applied = await run(vault, ['fix-sources', '--apply']);
    expect(applied).toMatchObject({
      applied: 1,
      fixes: [{ topic: 'a', from: 'old/source.md', to: 'new/source.md' }],
      ambiguous: [{ topic: 'a', from: 'dup/twin.md', candidates: ['one/twin.md', 'two/twin.md'] }],
    });
    expect(vault.registry()).toContain('"dup/twin.md"');
    expect(vault.registry()).toContain('"new/source.md"');
    expect(vault.registry().split('\n').length).toBe(text.split('\n').length);
  });

  it('looks a ~/ declaration up under its own subtree, never the vault', async () => {
    const vault = fakeVault(
      renderRegistry([{ slug: 'a', sources: ['~/.dotfiles/docs/runbook.md'] }]),
      {
        // Same basename in the vault: a root-blind index would pick this one.
        'vault/runbook.md': '# vault\n',
        '~/.dotfiles/scripts/runbook.md': '# dotfiles\n',
      },
    );
    expect(await run(vault, ['fix-sources'])).toMatchObject({
      fixes: [
        {
          topic: 'a',
          from: '~/.dotfiles/docs/runbook.md',
          to: '~/.dotfiles/scripts/runbook.md',
        },
      ],
    });
  });
});

describe('parseLearnArgs', () => {
  it.each([
    [['grade', 'r', 'c', 'meh']],
    [['read', 'a', 'x']],
    [['section', 'a']],
    [['round-result']],
    [['round', '--size', '0']],
    [['suspend', 'a/c01']],
    [['signal']],
    [['signal', '   ']],
    [['bogus']],
    [[]],
  ])('rejects %j', (args) => {
    expect(parseLearnArgs(args).ok).toBe(false);
  });

  it('truncates very long answers to the log limit', () => {
    const parsed = parseLearnArgs(['grade', 'r', 'c', 'good', '--answer', 'x'.repeat(5000)]);
    expect(parsed.ok && parsed.value.kind === 'grade' && parsed.value.answer?.length).toBe(4000);
  });

  it('keeps the message flags on lesson and round', () => {
    expect(parseLearnArgs(['lesson', '--message'])).toMatchObject({
      ok: true,
      value: { kind: 'lesson', message: true },
    });
    expect(parseLearnArgs(['round', '--message'])).toMatchObject({
      ok: true,
      value: { kind: 'round', message: true },
    });
  });
});
