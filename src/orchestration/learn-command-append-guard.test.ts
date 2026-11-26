import { describe, expect, it, vi } from 'vitest';
import { fakeVault, renderRegistry } from '../core/__fixtures__/learning.js';
import type { ProposalSlug, StudyEvent } from '../core/study-log.js';
import { UnwritableEventError, checkedAppend, runLearnCommand } from './learn-command.js';

// The guard's whole point is that a command can never put a line in the log the reader rejects.
// No command builds such an event today (the parsers bound everything), so the refusal path is
// exercised by making the writer's schema check fail once.
vi.mock('../core/study-log.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/study-log.js')>();
  return { ...actual, serializeWritable: vi.fn(actual.serializeWritable) };
});

const studyLog = await import('../core/study-log.js');
const registry = renderRegistry([{ slug: 'a' }]);
const NOW = new Date('2026-11-25T10:00:00.000Z');

const badEvent: StudyEvent = {
  kind: 'proposal-dismissed',
  at: NOW.toISOString(),
  slug: 'Not A Slug' as ProposalSlug,
  reason: '',
};

describe('checkedAppend', () => {
  it('writes nothing and throws a typed error when any event would be rejected on read', async () => {
    const vault = fakeVault(registry);
    const good: StudyEvent = { ...badEvent, slug: 'fine' as ProposalSlug, reason: 'ok' };
    await expect(checkedAppend(vault)([good, badEvent])).rejects.toBeInstanceOf(
      UnwritableEventError,
    );
    expect(vault.log()).toBe('');
  });

  it('writes every event when all pass', async () => {
    const vault = fakeVault(registry);
    const good: StudyEvent = { ...badEvent, slug: 'fine' as ProposalSlug, reason: 'ok' };
    await checkedAppend(vault)([good]);
    expect(vault.log().trim().split('\n')).toHaveLength(1);
  });
});

describe('runLearnCommand when the guard refuses', () => {
  it('returns the refusal as an error value, writes nothing, and leaves other failures to throw', async () => {
    const vault = fakeVault(registry);
    vi.mocked(studyLog.serializeWritable).mockReturnValueOnce({
      ok: false,
      error: ['line 1: slug is not a slug'],
    });
    const signal = JSON.stringify([
      { topics: ['a'], ref: 'https://example.com/x', source: 'S', title: 'T', takeaway: 'K' },
    ]);
    const result = await runLearnCommand(['signal', signal], vault, NOW);
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining('refusing to write an event the study log rejects'),
    });
    expect(vault.log()).toBe('');

    const boom = new Error('disk full');
    const broken = {
      ...vault,
      appendLog: async () => {
        throw boom;
      },
    };
    await expect(runLearnCommand(['signal', signal], broken, NOW)).rejects.toBe(boom);
  });
});
