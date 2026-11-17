import { describe, expect, it, vi } from 'vitest';
import { fakeDeadLetterStore, rawScheduled } from '../core/__fixtures__/dead-letter.js';
import { runDlqCommand } from './dlq-command.js';

const NOW = new Date('2026-11-17T10:00:00.000Z');
const FRESH = { triggeredAt: '2026-11-17T09:00:00.000Z', validUntil: '2026-11-17T12:00:00.000Z' };
const STALE = { triggeredAt: '2026-11-14T09:00:00.000Z', validUntil: '2026-11-14T10:00:00.000Z' };

const seed = () => [
  rawScheduled('f1', 'briefing', FRESH),
  rawScheduled('f2', 'garmin-sync', FRESH),
  rawScheduled('s1', 'learn-recall', STALE),
  rawScheduled('s2', 'learn-recall', STALE),
];

const deps = (store: ReturnType<typeof fakeDeadLetterStore>) => ({ store, now: () => NOW });

describe('runDlqCommand', () => {
  it('list changes nothing', async () => {
    const store = fakeDeadLetterStore(seed());
    const reply = await runDlqCommand({ kind: 'list' }, deps(store));
    expect(reply).toContain('Dead-letter queue: 2 fresh, 2 stale/unreadable');
    expect(store.failedIds()).toHaveLength(4);
    expect(store.retried).toEqual([]);
    expect(store.removed).toEqual([]);
  });

  it('retry re-queues every fresh job and leaves stale ones in place', async () => {
    const store = fakeDeadLetterStore(seed());
    const reply = await runDlqCommand({ kind: 'retry' }, deps(store));
    expect(store.retried).toEqual(['f1', 'f2']);
    expect(store.failedIds()).toEqual(['s1', 's2']);
    expect(reply).toContain('Retried 2 fresh jobs:');
    expect(reply).toContain('Skipped 2 stale/unreadable');
  });

  it('retry twice re-queues each fresh job once', async () => {
    const store = fakeDeadLetterStore(seed());
    await runDlqCommand({ kind: 'retry' }, deps(store));
    const second = await runDlqCommand({ kind: 'retry' }, deps(store));
    expect(store.retried).toEqual(['f1', 'f2']);
    expect(second).toContain('Nothing to retry');
  });

  it('clear removes stale jobs only, and a second clear removes nothing', async () => {
    const store = fakeDeadLetterStore(seed());
    const reply = await runDlqCommand({ kind: 'clear' }, deps(store));
    expect(store.removed).toEqual(['s1', 's2']);
    expect(store.failedIds()).toEqual(['f1', 'f2']);
    expect(reply).toBe('Cleared 2 stale/unreadable jobs.\nKept 2 fresh (/dlq retry re-runs them).');

    expect(await runDlqCommand({ kind: 'clear' }, deps(store))).toContain('Nothing to clear');
    expect(store.removed).toEqual(['s1', 's2']);
  });

  it('one failing retry is reported and does not stop the rest', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = fakeDeadLetterStore(seed(), { failOn: new Set(['f1']) });
    const reply = await runDlqCommand({ kind: 'retry' }, deps(store));
    expect(store.retried).toEqual(['f2']);
    expect(reply).toContain('Could not retry f1: redis said no to f1');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('f1'));
    spy.mockRestore();
  });

  it('a job that left the failed set between list and action reports as gone', async () => {
    const store = fakeDeadLetterStore(seed());
    const racing = {
      ...store,
      retry: async (jobId: string) => {
        if (jobId === 'f1') await store.retry('f1'); // someone else got there first
        return store.retry(jobId);
      },
    };
    const reply = await runDlqCommand({ kind: 'retry' }, { store: racing, now: () => NOW });
    expect(reply).toContain('Retried 1 fresh job:');
    expect(reply).toContain('1 had already left the failed set.');
  });
});
