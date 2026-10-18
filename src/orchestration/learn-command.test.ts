import { describe, expect, it } from 'vitest';
import { fakeVault, notePath, renderNote, renderRegistry } from '../core/__fixtures__/learning.js';
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

async function run(vault: ReturnType<typeof vaultWith>, args: string[], now = T0) {
  const result = await runLearnCommand(args, vault, now);
  if (!result.ok) throw new Error(result.error);
  return result.value as Record<string, unknown>;
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

describe('parseLearnArgs', () => {
  it.each([
    [['grade', 'r', 'c', 'meh']],
    [['read', 'a', 'x']],
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
});
