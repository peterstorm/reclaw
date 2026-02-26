import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkers, formatDeadLetterMessage, type BullWorkerLike, type WorkerFactory } from './worker.js';
import type { AppConfig } from '../infra/config.js';
import type { TelegramAdapter } from '../infra/telegram.js';
import type { ChatJob, JobId, JobResult, ScheduledJob, SkillId, TelegramUserId } from '../core/types.js';

// ─── Test data ────────────────────────────────────────────────────────────────

const mockConfig: AppConfig = {
  telegramToken: 'tok:test',
  authorizedUserIds: [111222333],
  redisHost: 'localhost',
  redisPort: 6379,
  workspacePath: '/workspace',
  skillsDir: '/workspace/skills',
  personalityPath: '/workspace/personality.md',
  claudeBinaryPath: 'claude',
  chatTimeoutMs: 120_000,
  scheduledTimeoutMs: 300_000,
};

const chatJob: ChatJob = {
  kind: 'chat',
  id: 'job-chat-001' as JobId,
  userId: 111222333 as TelegramUserId,
  text: 'Hello agent',
  chatId: 999888777,
  receivedAt: '2026-02-26T10:00:00Z',
};

const scheduledJob: ScheduledJob = {
  kind: 'scheduled',
  id: 'job-sched-001' as JobId,
  skillId: 'morning-briefing' as SkillId,
  triggeredAt: '2026-02-26T06:00:00Z',
  validUntil: '2026-02-26T06:30:00Z',
};

// ─── Fake worker factory ──────────────────────────────────────────────────────

type FakeBullJob = {
  data: unknown;
  id?: string;
  opts?: { attempts?: number };
  attemptsMade: number;
};

type WorkerProcessor = (job: FakeBullJob) => Promise<unknown>;

type CreatedWorker = {
  queueName: string;
  processor: WorkerProcessor;
  opts: { connection: { host: string; port: number }; concurrency: number };
  eventHandlers: Map<string, (...args: unknown[]) => void>;
  closeImpl: () => Promise<void>;
};

function makeFakeWorkerFactory(): {
  factory: WorkerFactory;
  createdWorkers: CreatedWorker[];
} {
  const createdWorkers: CreatedWorker[] = [];

  const factory: WorkerFactory = (queueName, processor, opts) => {
    const eventHandlers = new Map<string, (...args: unknown[]) => void>();
    const closeImpl = vi.fn().mockResolvedValue(undefined);

    const worker: BullWorkerLike = {
      on: (event, handler) => {
        eventHandlers.set(event, handler);
      },
      close: closeImpl,
    };

    createdWorkers.push({
      queueName,
      processor: processor as WorkerProcessor,
      opts,
      eventHandlers,
      closeImpl,
    });

    return worker;
  };

  return { factory, createdWorkers };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createWorkers', () => {
  let chatHandler: ReturnType<typeof vi.fn>;
  let scheduledHandler: ReturnType<typeof vi.fn>;
  let mockTelegram: TelegramAdapter;
  let fakeFactory: ReturnType<typeof makeFakeWorkerFactory>;

  beforeEach(() => {
    chatHandler = vi.fn().mockResolvedValue({ ok: true, response: 'chat response' } as JobResult);
    scheduledHandler = vi.fn().mockResolvedValue({ ok: true, response: 'scheduled response' } as JobResult);
    mockTelegram = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendChunkedMessage: vi.fn().mockResolvedValue(undefined),
      onMessage: vi.fn(),
    };
    fakeFactory = makeFakeWorkerFactory();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function makeWorkers() {
    return createWorkers({
      redisConnection: { host: 'localhost', port: 6379 },
      chatHandler,
      scheduledHandler,
      telegram: mockTelegram,
      config: mockConfig,
      workerFactory: fakeFactory.factory,
    });
  }

  it('returns object with start and stop', () => {
    const workers = makeWorkers();
    expect(workers.start).toBeTypeOf('function');
    expect(workers.stop).toBeTypeOf('function');
  });

  it('createWorkers returns object with start and stop functions', () => {
    const workers = makeWorkers();
    expect(typeof workers.start).toBe('function');
    expect(typeof workers.stop).toBe('function');
  });

  it('creates two workers', () => {
    makeWorkers();
    expect(fakeFactory.createdWorkers).toHaveLength(2);
  });

  it('creates workers for correct queue names', () => {
    makeWorkers();
    const queueNames = fakeFactory.createdWorkers.map((w) => w.queueName);
    expect(queueNames).toContain('reclaw-chat');
    expect(queueNames).toContain('reclaw-scheduled');
  });

  it('sets concurrency=1 for both workers (AD-4, FR-015)', () => {
    makeWorkers();
    for (const w of fakeFactory.createdWorkers) {
      expect(w.opts.concurrency).toBe(1);
    }
  });

  it('passes redis connection options to both workers', () => {
    createWorkers({
      redisConnection: { host: 'redis-host', port: 6380 },
      chatHandler,
      scheduledHandler,
      telegram: mockTelegram,
      config: mockConfig,
      workerFactory: fakeFactory.factory,
    });

    for (const w of fakeFactory.createdWorkers) {
      expect(w.opts.connection).toEqual({ host: 'redis-host', port: 6380 });
    }
  });

  it('chat worker processes ChatJob via chatHandler', async () => {
    makeWorkers();

    const chatWorker = fakeFactory.createdWorkers.find((w) => w.queueName === 'reclaw-chat');
    expect(chatWorker).toBeDefined();

    const bullJob: FakeBullJob = {
      data: chatJob,
      id: chatJob.id,
      opts: { attempts: 3 },
      attemptsMade: 1,
    };

    const result = await chatWorker!.processor(bullJob);
    expect(chatHandler).toHaveBeenCalledWith(chatJob);
    expect(result).toEqual({ ok: true, response: 'chat response' });
  });

  it('scheduled worker processes ScheduledJob via scheduledHandler', async () => {
    makeWorkers();

    const scheduledWorker = fakeFactory.createdWorkers.find((w) => w.queueName === 'reclaw-scheduled');
    expect(scheduledWorker).toBeDefined();

    const bullJob: FakeBullJob = {
      data: scheduledJob,
      id: scheduledJob.id,
      opts: { attempts: 3 },
      attemptsMade: 1,
    };

    const result = await scheduledWorker!.processor(bullJob);
    expect(scheduledHandler).toHaveBeenCalledWith(scheduledJob);
    expect(result).toEqual({ ok: true, response: 'scheduled response' });
  });

  it('chat worker throws on handler failure', async () => {
    chatHandler = vi.fn().mockResolvedValue({ ok: false, error: 'claude failed' } as JobResult);

    createWorkers({
      redisConnection: { host: 'localhost', port: 6379 },
      chatHandler,
      scheduledHandler,
      telegram: mockTelegram,
      config: mockConfig,
      workerFactory: fakeFactory.factory,
    });

    const chatWorker = fakeFactory.createdWorkers.find((w) => w.queueName === 'reclaw-chat');
    const bullJob: FakeBullJob = {
      data: chatJob,
      id: chatJob.id,
      opts: { attempts: 3 },
      attemptsMade: 1,
    };

    await expect(chatWorker!.processor(bullJob)).rejects.toThrow('claude failed');
  });

  it('scheduled worker throws on handler failure', async () => {
    scheduledHandler = vi.fn().mockResolvedValue({ ok: false, error: 'subprocess timed out' } as JobResult);

    createWorkers({
      redisConnection: { host: 'localhost', port: 6379 },
      chatHandler,
      scheduledHandler,
      telegram: mockTelegram,
      config: mockConfig,
      workerFactory: fakeFactory.factory,
    });

    const scheduledWorker = fakeFactory.createdWorkers.find((w) => w.queueName === 'reclaw-scheduled');
    const bullJob: FakeBullJob = {
      data: scheduledJob,
      id: scheduledJob.id,
      opts: { attempts: 3 },
      attemptsMade: 1,
    };

    await expect(scheduledWorker!.processor(bullJob)).rejects.toThrow('subprocess timed out');
  });

  it('dead letter: sends telegram notification on final chat job failure', async () => {
    makeWorkers();

    const chatWorker = fakeFactory.createdWorkers.find((w) => w.queueName === 'reclaw-chat');
    const failedHandler = chatWorker!.eventHandlers.get('failed');
    expect(failedHandler).toBeDefined();

    await failedHandler!(
      { data: chatJob, id: chatJob.id, opts: { attempts: 3 }, attemptsMade: 3 },
      new Error('final failure'),
    );

    expect(mockTelegram.sendMessage).toHaveBeenCalledWith(
      chatJob.chatId,
      expect.stringContaining('permanently failed'),
    );
  });

  it('dead letter: sends telegram notification on final scheduled job failure to all users', async () => {
    makeWorkers();

    const scheduledWorker = fakeFactory.createdWorkers.find((w) => w.queueName === 'reclaw-scheduled');
    const failedHandler = scheduledWorker!.eventHandlers.get('failed');
    expect(failedHandler).toBeDefined();

    await failedHandler!(
      { data: scheduledJob, id: scheduledJob.id, opts: { attempts: 3 }, attemptsMade: 3 },
      new Error('scheduled final failure'),
    );

    expect(mockTelegram.sendMessage).toHaveBeenCalledWith(
      mockConfig.authorizedUserIds[0],
      expect.stringContaining('permanently failed'),
    );
  });

  it('dead letter: does NOT send notification if retries not exhausted', async () => {
    makeWorkers();

    const chatWorker = fakeFactory.createdWorkers.find((w) => w.queueName === 'reclaw-chat');
    const failedHandler = chatWorker!.eventHandlers.get('failed');

    // attemptsMade=2, maxAttempts=3 → NOT final failure
    await failedHandler!(
      { data: chatJob, id: chatJob.id, opts: { attempts: 3 }, attemptsMade: 2 },
      new Error('transient failure'),
    );

    expect(mockTelegram.sendMessage).not.toHaveBeenCalled();
  });

  it('stop gracefully closes both workers', async () => {
    const workers = makeWorkers();
    await workers.stop();

    for (const w of fakeFactory.createdWorkers) {
      expect(w.closeImpl).toHaveBeenCalledOnce();
    }
  });

  it('start is a no-op (BullMQ auto-starts)', () => {
    const workers = makeWorkers();
    expect(() => workers.start()).not.toThrow();
  });

  it('registers error event handler on both workers', () => {
    makeWorkers();
    for (const w of fakeFactory.createdWorkers) {
      expect(w.eventHandlers.has('error')).toBe(true);
    }
  });

  it('dead letter message includes job kind, id, and error', async () => {
    makeWorkers();

    const chatWorker = fakeFactory.createdWorkers.find((w) => w.queueName === 'reclaw-chat');
    const failedHandler = chatWorker!.eventHandlers.get('failed');

    await failedHandler!(
      { data: chatJob, id: 'specific-job-id', opts: { attempts: 3 }, attemptsMade: 3 },
      new Error('specific error message'),
    );

    expect(mockTelegram.sendMessage).toHaveBeenCalledWith(
      chatJob.chatId,
      expect.stringContaining('specific error message'),
    );
  });
});

// ─── formatDeadLetterMessage ──────────────────────────────────────────────────

describe('formatDeadLetterMessage', () => {
  it('includes kind, id, and error in message', () => {
    const msg = formatDeadLetterMessage('chat', 'job-123', 'Claude crashed');
    expect(msg).toContain('chat');
    expect(msg).toContain('job-123');
    expect(msg).toContain('Claude crashed');
  });

  it('includes "permanently failed" language', () => {
    const msg = formatDeadLetterMessage('scheduled', 'job-abc', 'timeout');
    expect(msg).toContain('permanently failed');
  });

  it('formats all three fields', () => {
    const msg = formatDeadLetterMessage('scheduled', 'sched-xyz', 'redis timeout');
    expect(msg).toContain('scheduled');
    expect(msg).toContain('sched-xyz');
    expect(msg).toContain('redis timeout');
  });
});
