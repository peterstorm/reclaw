import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeActivityId, makeDeliveryId } from '../core/activity.js';
import {
  type ConversationGeneration,
  type ConversationRevision,
  makeAgentSessionId,
  makeChatJob as makeChatJobCore,
  makeTelegramIngressJobId,
  makeTelegramUpdateId,
  makeTelegramUserId,
} from '../core/types.js';
import { type Workers, createWorkers } from '../orchestration/worker.js';
import type { AppConfig } from './config.js';
import { type Queues, createQueues } from './queue.js';
import { createSessionStore } from './session-store.js';
import type { TelegramAdapter } from './telegram.js';

const makeChatJob = (params: Omit<Parameters<typeof makeChatJobCore>[0], 'conversation'>) =>
  makeChatJobCore({
    ...params,
    conversation: {
      generation: 0 as ConversationGeneration,
      revision: 0 as ConversationRevision,
      backend: 'claude',
      sessionId: null,
    },
  });

const makeConversationStore = () => ({
  getCurrent: vi.fn().mockResolvedValue({
    schemaVersion: 1 as const,
    generation: 0 as ConversationGeneration,
    revision: 0 as ConversationRevision,
    backend: 'claude' as const,
    sessionId: null,
    lastActivityAt: '2026-08-14T08:00:00.000Z',
  }),
  advance: vi.fn(),
  commitSession: vi.fn().mockResolvedValue({ kind: 'committed' as const }),
  saveMessageReference: vi.fn().mockResolvedValue(undefined),
  getMessageReference: vi.fn().mockResolvedValue(null),
});

const reservePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('Failed to reserve an isolated Redis port');
  }
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  return address.port;
};

const closeQueues = async (queues: Queues): Promise<void> => {
  await Promise.all([
    queues.chat.close(),
    queues.scheduled.close(),
    queues.reminder.close(),
    queues.research.close(),
    queues.podcast.close(),
    queues.delivery.close(),
  ]);
};

const waitForRedis = async (port: number): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Isolated Redis did not start within 5 seconds');
};

describe('BullMQ runtime with isolated Redis', () => {
  let redis: ChildProcess;
  let redisDirectory: string;
  let port: number;

  beforeAll(async () => {
    port = await reservePort();
    redisDirectory = await mkdtemp(join(tmpdir(), 'reclaw-ingress-redis-'));
    redis = spawn(
      'redis-server',
      [
        '--bind',
        '127.0.0.1',
        '--port',
        String(port),
        '--save',
        '',
        '--appendonly',
        'no',
        '--dir',
        redisDirectory,
      ],
      { stdio: 'ignore' },
    );

    await waitForRedis(port);
  });

  afterAll(async () => {
    if (redis !== undefined && redis.exitCode === null) {
      redis.kill('SIGTERM');
      await new Promise<void>((resolve) => redis.once('exit', () => resolve()));
    }
    if (redisDirectory !== undefined) {
      await rm(redisDirectory, { recursive: true, force: true });
    }
  });

  it('collapses duplicate Telegram delivery and preserves accepted work across queue reconnection', async () => {
    const updateId = makeTelegramUpdateId(91_337);
    const userId = makeTelegramUserId(123_456);
    if (!updateId.ok || !userId.ok) throw new Error('Invalid integration-test identity fixture');

    const jobId = makeTelegramIngressJobId(updateId.value, 'chat');
    if (!jobId.ok) throw new Error(jobId.error);
    const job = makeChatJob({
      id: jobId.value,
      userId: userId.value,
      text: 'Process this once',
      chatId: 654_321,
      receivedAt: '2026-08-14T08:45:00.000Z',
    });
    if (!job.ok) throw new Error(job.error);

    const firstConnection = createQueues({ host: '127.0.0.1', port });
    await firstConnection.enqueueChat(job.value);
    await firstConnection.enqueueChat(job.value);
    expect(await firstConnection.chat.getWaitingCount()).toBe(1);
    await closeQueues(firstConnection);

    const reopened = createQueues({ host: '127.0.0.1', port });
    try {
      const persisted = await reopened.chat.getJob(jobId.value);
      expect(persisted?.data).toEqual(job.value);
      expect(await reopened.chat.getWaitingCount()).toBe(1);
    } finally {
      await reopened.chat.drain();
      await closeQueues(reopened);
    }
  });

  it('atomically advances generations and rejects stale session commits', async () => {
    const { default: Redis } = await import('ioredis');
    const redis = new Redis({ host: '127.0.0.1', port, maxRetriesPerRequest: null });
    const store = createSessionStore(
      {
        get: (key) => redis.get(key),
        set: (key, value, options) =>
          options?.PX === undefined
            ? redis.set(key, value)
            : redis.set(key, value, 'PX', options.PX),
        del: (key) => redis.del(key),
        eval: (script, numberOfKeys, ...args) => redis.eval(script, numberOfKeys, ...args),
      },
      'pi',
      () => '2026-08-14T08:00:00.000Z',
    );
    const chatId = 991_339;
    const firstSession = makeAgentSessionId('session-first');
    const staleSession = makeAgentSessionId('session-stale');
    if (!firstSession.ok || !staleSession.ok) throw new Error('Invalid session fixture');

    try {
      const initial = await store.getCurrent(chatId);
      expect(initial).toMatchObject({ generation: 0, revision: 0, backend: 'pi' });

      const selected = await store.advance(
        chatId,
        'telegram:91339:chat',
        { kind: 'fresh', backend: 'pi' },
        '2026-08-14T08:01:00.000Z',
      );
      const duplicate = await store.advance(
        chatId,
        'telegram:91339:chat',
        { kind: 'fresh', backend: 'pi' },
        '2026-08-14T08:01:01.000Z',
      );
      expect(selected).toEqual(duplicate);
      expect(selected).toMatchObject({ generation: 1, revision: 0, sessionId: null });

      const committed = await store.commitSession({
        chatId,
        expectedGeneration: selected.generation,
        expectedRevision: selected.revision,
        backend: 'pi',
        sessionId: firstSession.value,
        lastActivityAt: '2026-08-14T08:02:00.000Z',
      });
      expect(committed).toMatchObject({
        kind: 'committed',
        lineage: { generation: 1, revision: 1, sessionId: 'session-first' },
      });

      const delayedOlderCommit = await store.commitSession({
        chatId,
        expectedGeneration: selected.generation,
        expectedRevision: selected.revision,
        backend: 'pi',
        sessionId: staleSession.value,
        lastActivityAt: '2026-08-14T08:02:30.000Z',
      });
      expect(delayedOlderCommit).toMatchObject({
        kind: 'stale',
        current: { generation: 1, revision: 1, sessionId: 'session-first' },
      });

      const reset = await store.advance(
        chatId,
        'telegram:91340:chat',
        { kind: 'fresh', backend: 'pi' },
        '2026-08-14T08:03:00.000Z',
      );
      expect(reset).toMatchObject({ generation: 2, revision: 0, sessionId: null });

      const stale = await store.commitSession({
        chatId,
        expectedGeneration: 1 as ConversationGeneration,
        expectedRevision: 1 as ConversationRevision,
        backend: 'pi',
        sessionId: staleSession.value,
        lastActivityAt: '2026-08-14T08:04:00.000Z',
      });
      expect(stale).toMatchObject({
        kind: 'stale',
        current: { generation: 2, revision: 0, sessionId: null },
      });
      await expect(store.getCurrent(chatId)).resolves.toMatchObject({
        generation: 2,
        revision: 0,
        sessionId: null,
      });

      await redis.set(`reclaw-session-${chatId}`, 'not-json');
      await expect(store.getCurrent(chatId)).rejects.toThrow('Corrupt conversation lineage');
      await expect(
        store.advance(
          chatId,
          'telegram:91341:chat',
          { kind: 'fresh', backend: 'pi' },
          '2026-08-14T08:05:00.000Z',
        ),
      ).rejects.toThrow('CORRUPT_CONVERSATION_LINEAGE');
      expect(await redis.get(`reclaw-session-${chatId}`)).toBe('not-json');
    } finally {
      await redis.del(
        'reclaw-session-991339',
        ...((await redis.keys('reclaw-conversation-mutation-991339-*')) as string[]),
      );
      await redis.quit();
    }
  });

  it('does not retry a permanent typed agent failure', async () => {
    const updateId = makeTelegramUpdateId(91_339);
    const userId = makeTelegramUserId(123_456);
    if (!updateId.ok || !userId.ok) throw new Error('Invalid integration-test identity fixture');
    const jobId = makeTelegramIngressJobId(updateId.value, 'chat');
    if (!jobId.ok) throw new Error(jobId.error);
    const job = makeChatJob({
      id: jobId.value,
      userId: userId.value,
      text: 'Fail permanently once',
      chatId: 654_321,
      receivedAt: '2026-08-14T08:47:00.000Z',
    });
    if (!job.ok) throw new Error(job.error);

    const config: AppConfig = {
      telegramToken: 'test-token',
      authorizedUserIds: [123_456],
      redisHost: '127.0.0.1',
      redisPort: port,
      workspacePath: '/tmp/reclaw-worker-integration',
      skillsDir: '/tmp/reclaw-worker-integration/skills',
      personalityPath: '/tmp/reclaw-worker-integration/personality.md',
      chatTimeoutMs: 120_000,
      scheduledTimeoutMs: 300_000,
      latitude: 55.665,
      longitude: 12.57,
      timezone: 'Europe/Copenhagen',
      locationName: 'Copenhagen',
      agentBackend: 'claude',
    };
    const telegram: TelegramAdapter = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(1),
      editMessage: vi.fn().mockResolvedValue(undefined),
      sendChunkedMessage: vi.fn().mockResolvedValue([1]),
      onMessage: vi.fn(),
    };
    const chatHandler = vi.fn().mockResolvedValue({
      kind: 'failed',
      failure: {
        kind: 'provider-authentication',
        backend: 'pi',
        detail: 'invalid API key',
      },
    });
    const queues = createQueues({ host: '127.0.0.1', port });
    const workers = createWorkers({
      redisConnection: { host: '127.0.0.1', port },
      chatHandler,
      scheduledHandler: vi.fn().mockResolvedValue({
        kind: 'completed',
        response: 'unused',
        suppressed: false,
        sessionId: null,
      }),
      reminderHandler: vi.fn().mockResolvedValue({ ok: true, response: 'unused' }),
      recurringReminderHandler: vi.fn().mockResolvedValue({ ok: true, response: 'unused' }),
      researchHandler: vi.fn().mockResolvedValue({ hubPath: null, topic: 'unused' }),
      podcastHandler: vi.fn().mockResolvedValue({ ok: true, response: 'unused' }),
      telegram,
      sessionStore: makeConversationStore(),
      activityResults: queues.activityResults,
      deliveryOutbox: queues.deliveryOutbox,
      config,
      onScheduledJobCompleted: vi.fn().mockResolvedValue(undefined),
      markScheduledJobCompleted: vi.fn().mockResolvedValue(undefined),
    });

    try {
      await queues.enqueueChat(job.value);
      await workers.start();
      const queued = await queues.chat.getJob(job.value.id);
      if (queued === undefined) throw new Error('Permanent-failure job missing');
      await vi.waitFor(async () => expect(await queued.getState()).toBe('failed'), {
        timeout: 2_000,
      });
      await vi.waitFor(() => expect(telegram.sendMessage).toHaveBeenCalledOnce(), {
        timeout: 2_000,
      });
      const failedJob = await queues.chat.getJob(job.value.id);
      if (failedJob === undefined) throw new Error('Failed job disappeared');
      // Both counters prove one processor invocation occurred and no configured
      // retry attempt was consumed after the unrecoverable failure.
      expect(failedJob.attemptsMade).toBe(1);
      expect(failedJob.attemptsStarted).toBe(1);
      expect(chatHandler).toHaveBeenCalledOnce();
    } finally {
      await workers.stop();
      await closeQueues(queues);
    }
  });

  it('does not consume queued work until the explicit worker lifecycle gate opens', async () => {
    const updateId = makeTelegramUpdateId(91_338);
    const userId = makeTelegramUserId(123_456);
    if (!updateId.ok || !userId.ok) throw new Error('Invalid integration-test identity fixture');
    const jobId = makeTelegramIngressJobId(updateId.value, 'chat');
    if (!jobId.ok) throw new Error(jobId.error);
    const job = makeChatJob({
      id: jobId.value,
      userId: userId.value,
      text: 'Wait for runtime readiness',
      chatId: 654_321,
      receivedAt: '2026-08-14T08:46:00.000Z',
    });
    if (!job.ok) throw new Error(job.error);

    const config: AppConfig = {
      telegramToken: 'test-token',
      authorizedUserIds: [123_456],
      redisHost: '127.0.0.1',
      redisPort: port,
      workspacePath: '/tmp/reclaw-worker-integration',
      skillsDir: '/tmp/reclaw-worker-integration/skills',
      personalityPath: '/tmp/reclaw-worker-integration/personality.md',
      chatTimeoutMs: 120_000,
      scheduledTimeoutMs: 300_000,
      latitude: 55.665,
      longitude: 12.57,
      timezone: 'Europe/Copenhagen',
      locationName: 'Copenhagen',
      agentBackend: 'claude',
    };
    const telegram: TelegramAdapter = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(1),
      editMessage: vi.fn().mockResolvedValue(undefined),
      sendChunkedMessage: vi.fn().mockResolvedValue([1]),
      onMessage: vi.fn(),
    };
    const chatHandler = vi.fn().mockResolvedValue({
      kind: 'completed',
      response: 'done',
      sessionId: null,
      telegramOperations: [{ kind: 'send', text: 'done', format: 'plain' }],
      sourcePaths: [],
      drainPreviews: vi.fn().mockResolvedValue(undefined),
    });

    const queues = createQueues({ host: '127.0.0.1', port });
    const createRuntimeWorkers = (): Workers =>
      createWorkers({
        redisConnection: { host: '127.0.0.1', port },
        chatHandler,
        scheduledHandler: vi.fn().mockResolvedValue({
          kind: 'completed',
          response: 'done',
          suppressed: false,
          sessionId: null,
        }),
        reminderHandler: vi.fn().mockResolvedValue({ ok: true, response: 'done' }),
        recurringReminderHandler: vi.fn().mockResolvedValue({ ok: true, response: 'done' }),
        researchHandler: vi.fn().mockResolvedValue({ hubPath: null, topic: 'unused' }),
        podcastHandler: vi.fn().mockResolvedValue({ ok: true, response: 'done' }),
        telegram,
        sessionStore: makeConversationStore(),
        activityResults: queues.activityResults,
        deliveryOutbox: queues.deliveryOutbox,
        config,
        onScheduledJobCompleted: vi.fn().mockResolvedValue(undefined),
        markScheduledJobCompleted: vi.fn().mockResolvedValue(undefined),
      });
    let workers: Workers | null = null;
    try {
      await queues.enqueueChat(job.value);
      workers = createRuntimeWorkers();

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(chatHandler).not.toHaveBeenCalled();
      expect(await queues.chat.getWaitingCount()).toBe(1);

      await workers.start();
      await vi.waitFor(() => expect(chatHandler).toHaveBeenCalledOnce(), { timeout: 2_000 });
      await vi.waitFor(() => expect(telegram.sendMessage).toHaveBeenCalledOnce(), {
        timeout: 2_000,
      });
      expect(chatHandler).toHaveBeenCalledWith(job.value);

      const activityId = makeActivityId('chat', job.value.id);
      const deliveryId = makeDeliveryId(activityId, 'telegram-batch', String(job.value.chatId));
      if (!deliveryId.ok) throw new Error(deliveryId.error);
      const completedDelivery = await queues.delivery.getJob(deliveryId.value);
      if (completedDelivery === undefined) throw new Error('Delivery job missing');
      await vi.waitFor(async () => expect(await completedDelivery.getState()).toBe('completed'), {
        timeout: 2_000,
      });
      expect(completedDelivery.data).toMatchObject({
        nextOperation: 1,
        sentMessageIds: [1],
      });

      // Remove only BullMQ's source-job record and enqueue the same durable
      // identity again. The Redis ActivityResult and completed outbox job remain.
      const completedSource = await queues.chat.getJob(job.value.id);
      if (completedSource === undefined) throw new Error('Completed source job missing');
      await vi.waitFor(async () => expect(await completedSource.getState()).toBe('completed'), {
        timeout: 2_000,
      });
      await workers.stop();
      workers = null;
      await completedSource.remove();
      chatHandler.mockClear();
      await queues.enqueueChat(job.value);

      workers = createRuntimeWorkers();
      await workers.start();
      const replayedSource = await queues.chat.getJob(job.value.id);
      if (replayedSource === undefined) throw new Error('Replayed source job missing');
      await vi.waitFor(async () => expect(await replayedSource.getState()).toBe('completed'), {
        timeout: 2_000,
      });

      expect(chatHandler).not.toHaveBeenCalled();
      expect(telegram.sendMessage).toHaveBeenCalledOnce();
    } finally {
      await workers?.stop();
      await queues.chat.drain();
      await closeQueues(queues);
    }
  });
});
