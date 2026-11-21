import { describe, expect, it } from 'vitest';
import { fakeVault, notePath, renderNote, renderRegistry } from '../core/__fixtures__/learning.js';
import { ALL_CLEAR } from '../core/learning-messages.js';
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
      error: expect.stringContaining('lesson 9 not found'),
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
});

describe('parseLearnArgs', () => {
  it.each([
    [['grade', 'r', 'c', 'meh']],
    [['read', 'a', 'x']],
    [['section', 'a']],
    [['round-result']],
    [['round', '--size', '0']],
    [['suspend', 'a/c01']],
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
