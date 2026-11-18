import { vi } from 'vitest';
import { fakeDeadLetterStore } from '../../core/__fixtures__/dead-letter.js';
import type { Queues } from '../queue.js';

type QueueHandle = 'chat' | 'scheduled' | 'reminder' | 'research' | 'podcast' | 'delivery';

/**
 * Every `Queues` operation except the six BullMQ queue handles, as `vi.fn` fakes that
 * succeed with neutral values (nothing stored, nothing waiting). Tests add the handles
 * their subject touches and override single operations per case.
 */
export const fakeQueueOperations = () =>
  ({
    activityResults: {
      find: vi.fn().mockResolvedValue(null),
      saveIfAbsent: vi.fn(),
    },
    deliveryOutbox: { enqueue: vi.fn().mockResolvedValue(undefined) },
    enqueueChat: vi.fn().mockResolvedValue(undefined),
    enqueueScheduled: vi.fn().mockResolvedValue(undefined),
    isScheduledJobKnown: vi.fn().mockResolvedValue(false),
    isScheduledJobCompleted: vi.fn().mockResolvedValue(false),
    markScheduledJobCompleted: vi.fn().mockResolvedValue(undefined),
    enqueueReminder: vi.fn().mockResolvedValue(undefined),
    enqueueRecurringReminder: vi.fn().mockResolvedValue('recur:123'),
    listRecurringReminders: vi.fn().mockResolvedValue([]),
    cancelRecurringReminder: vi.fn().mockResolvedValue(true),
    enqueueResearch: vi.fn().mockResolvedValue(undefined),
    getResearchQueuePosition: vi.fn().mockResolvedValue(1),
    getResearchStatus: vi.fn().mockResolvedValue({ active: null, waiting: 0 }),
    enqueuePodcast: vi.fn().mockResolvedValue(undefined),
    deadLetters: fakeDeadLetterStore([]),
  }) satisfies Omit<Queues, QueueHandle>;
