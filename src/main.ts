import { makeChatJob, makeJobId, makeReminderJob, makeTelegramUserId } from './core/types.js';
import { parseRemindCommand, formatDuration } from './core/reminder.js';
import type { AppConfig } from './infra/config.js';
import type { TelegramAdapter } from './infra/telegram.js';
import type { createTelegramAdapter } from './infra/telegram.js';
import type { Queues } from './infra/queue.js';
import type { SkillWatcher } from './infra/skill-watcher.js';
import type { SessionStore } from './infra/session-store.js';
import type { CronScheduler } from './orchestration/scheduler.js';
import type { Workers } from './orchestration/worker.js';
import type { Result, ScheduledJob, ChatJob, JobResult } from './core/types.js';
import type { runClaude } from './infra/claude-subprocess.js';
import type { handleChatJob } from './orchestration/chat-handler.js';
import type { handleScheduledJob } from './orchestration/scheduled-handler.js';
import type { handleReminderJob } from './orchestration/reminder-handler.js';

// ─── Injectable deps (for testability) ───────────────────────────────────────

export type BootstrapDeps = {
  readonly loadConfigFn?: () => Result<AppConfig, string>;
  readonly createTelegramAdapterFn?: typeof createTelegramAdapter;
  readonly createQueuesFn?: (conn: { host: string; port: number }) => Queues;
  readonly createSkillWatcherFn?: (dir: string) => SkillWatcher;
  readonly createSchedulerFn?: (enq: (job: ScheduledJob) => Promise<void>) => CronScheduler;
  readonly createWorkersFn?: (deps: {
    redisConnection: { host: string; port: number };
    chatHandler: (job: ChatJob) => Promise<JobResult>;
    scheduledHandler: (job: ScheduledJob) => Promise<JobResult>;
    telegram: TelegramAdapter;
    config: AppConfig;
  }) => Workers;
  readonly runClaudeFn?: typeof runClaude;
  readonly handleChatJobFn?: typeof handleChatJob;
  readonly handleScheduledJobFn?: typeof handleScheduledJob;
  readonly handleReminderJobFn?: typeof handleReminderJob;
  readonly createSessionStoreFn?: (redis: { host: string; port: number }) => {
    sessionStore: SessionStore;
    disconnect: () => Promise<void>;
  };
};

// ─── Bootstrap ────────────────────────────────────────────────────────────────

/**
 * Bootstrap the agent: load config, wire all components, start services.
 * Returns a shutdown function. Exported for testability.
 *
 * Infrastructure modules are conditionally loaded lazily — only when the
 * corresponding dep is not injected. This lets tests provide mocks without
 * triggering zod-dependent module initialization.
 *
 * FR-004: Scheduled tasks via cron scheduler.
 * FR-009: Personality file shapes agent behavior.
 * FR-040: Deployable as containerized workload.
 * US2: Morning briefing at 7am.
 * US3: HN AI digest on Fridays.
 * US4: Agent workspace with Cortex memory.
 */
export async function bootstrap(injected: BootstrapDeps = {}): Promise<() => Promise<void>> {
  // Conditionally load real implementations only when not injected.
  const loadConfigFn: () => Result<AppConfig, string> =
    injected.loadConfigFn ??
    (await import('./infra/config.js').then((m) => m.loadConfig));

  const createTelegramAdapterFn: typeof createTelegramAdapter =
    injected.createTelegramAdapterFn ??
    (await import('./infra/telegram.js').then((m) => m.createTelegramAdapter));

  const createQueuesFn: (conn: { host: string; port: number }) => Queues =
    injected.createQueuesFn ??
    (await import('./infra/queue.js').then((m) => m.createQueues));

  const createSkillWatcherFn: (dir: string) => SkillWatcher =
    injected.createSkillWatcherFn ??
    (await import('./infra/skill-watcher.js').then((m) => m.createSkillWatcher));

  const createSchedulerFn: (enq: (job: ScheduledJob) => Promise<void>) => CronScheduler =
    injected.createSchedulerFn ??
    (await import('./orchestration/scheduler.js').then((m) => m.createScheduler));

  const createWorkersFn =
    injected.createWorkersFn ??
    (await import('./orchestration/worker.js').then((m) => m.createWorkers));

  const runClaudeFn: typeof runClaude =
    injected.runClaudeFn ??
    (await import('./infra/claude-subprocess.js').then((m) => m.runClaude));

  const handleChatJobFn: typeof handleChatJob =
    injected.handleChatJobFn ??
    (await import('./orchestration/chat-handler.js').then((m) => m.handleChatJob));

  const handleScheduledJobFn: typeof handleScheduledJob =
    injected.handleScheduledJobFn ??
    (await import('./orchestration/scheduled-handler.js').then((m) => m.handleScheduledJob));

  const handleReminderJobFn: typeof handleReminderJob =
    injected.handleReminderJobFn ??
    (await import('./orchestration/reminder-handler.js').then((m) => m.handleReminderJob));

  // ── 1. Load config — exit on failure ─────────────────────────────────────
  const configResult = loadConfigFn();
  if (!configResult.ok) {
    console.error(`[main] Config error: ${configResult.error}`);
    process.exit(1);
  }
  const config = configResult.value;

  console.info('[main] Config loaded');

  // ── 2. Create Telegram adapter ────────────────────────────────────────────
  const userIds: import('./core/types.js').TelegramUserId[] = [];
  for (const rawId of config.authorizedUserIds) {
    const r = makeTelegramUserId(rawId);
    if (!r.ok) {
      console.error(`[main] Invalid authorizedUserIds entry: ${r.error}`);
      process.exit(1);
    }
    userIds.push(r.value);
  }

  const telegram: TelegramAdapter = createTelegramAdapterFn({
    token: config.telegramToken,
    authorizedUserIds: userIds,
  });

  // ── 3. Create BullMQ queues ────────────────────────────────────────────────
  const queues: Queues = createQueuesFn({
    host: config.redisHost,
    port: config.redisPort,
  });

  // ── 4. Create session store ────────────────────────────────────────────────
  const createSessionStoreFn = injected.createSessionStoreFn ?? (async (redis: { host: string; port: number }) => {
    const { default: Redis } = await import('ioredis');
    const ioredis = new Redis({ host: redis.host, port: redis.port, maxRetriesPerRequest: null });
    const { createSessionStore } = await import('./infra/session-store.js');
    // Adapt ioredis to our minimal RedisClient interface
    const client: import('./infra/session-store.js').RedisClient = {
      get: (key) => ioredis.get(key),
      set: (key, value, options) => {
        if (options?.PX) return ioredis.set(key, value, 'PX', options.PX);
        return ioredis.set(key, value);
      },
      del: (key) => ioredis.del(key),
    };
    return {
      sessionStore: createSessionStore(client),
      disconnect: () => ioredis.quit().then(() => {}),
    };
  });

  const { sessionStore, disconnect: disconnectRedis } = await createSessionStoreFn({
    host: config.redisHost,
    port: config.redisPort,
  });

  console.info('[main] Session store created');

  // ── 5. Create skill watcher ────────────────────────────────────────────────
  const skillWatcher: SkillWatcher = createSkillWatcherFn(config.skillsDir);

  // ── 6. Create scheduler ────────────────────────────────────────────────────
  const scheduler: CronScheduler = createSchedulerFn(queues.enqueueScheduled);

  // ── 7. Wire skill watcher onChange to scheduler.reconcile ─────────────────
  skillWatcher.onRegistryChange((registry) => {
    try {
      scheduler.reconcile(registry);
    } catch (err: unknown) {
      console.error('[main] Failed to reconcile scheduler:', err);
    }
  });

  // ── 8. Create workers ──────────────────────────────────────────────────────
  const workers: Workers = createWorkersFn({
    redisConnection: { host: config.redisHost, port: config.redisPort },
    chatHandler: (job) => handleChatJobFn(job, { runClaude: runClaudeFn, telegram, config, sessionStore }),
    scheduledHandler: (job) =>
      handleScheduledJobFn(job, {
        runClaude: runClaudeFn,
        telegram,
        skillRegistry: skillWatcher.getRegistry(),
        config,
      }),
    reminderHandler: (job) => handleReminderJobFn(job, { telegram }),
    telegram,
    config,
  });

  // ── 9. Wire Telegram onMessage → enqueue chat job or handle /new ──────────
  telegram.onMessage((msg) => {
    const userIdResult = makeTelegramUserId(msg.userId);
    if (!userIdResult.ok) {
      console.error(`[main] Invalid userId from Telegram: ${userIdResult.error}`);
      return;
    }

    // Handle /new command — clear session
    if (msg.text.trim() === '/new') {
      sessionStore.deleteSession(msg.chatId).then(() => {
        return telegram.sendMessage(msg.chatId, 'Session cleared. Next message starts a fresh conversation.');
      }).catch((err: unknown) => {
        console.error('[main] Failed to handle /new command:', err);
      });
      return;
    }

    // Handle /remind command — schedule a one-off delayed reminder
    if (msg.text.trim().startsWith('/remind')) {
      const parseResult = parseRemindCommand(msg.text);
      if (!parseResult.ok) {
        telegram.sendMessage(msg.chatId, parseResult.error).catch((err: unknown) => {
          console.error('[main] Failed to send /remind usage error:', err);
        });
        return;
      }

      const jobIdRaw = `reminder:${msg.userId}:${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      const jobIdResult = makeJobId(jobIdRaw);
      if (!jobIdResult.ok) {
        console.error(`[main] Failed to create reminder jobId: ${jobIdResult.error}`);
        return;
      }

      const reminderResult = makeReminderJob({
        id: jobIdResult.value,
        chatId: msg.chatId,
        text: parseResult.value.text,
        createdAt: new Date().toISOString(),
        delayMs: parseResult.value.delayMs,
      });

      if (!reminderResult.ok) {
        console.error(`[main] Failed to create ReminderJob: ${reminderResult.error}`);
        return;
      }

      queues.enqueueReminder(reminderResult.value)
        .then(() => {
          const duration = formatDuration(parseResult.value.delayMs);
          return telegram.sendMessage(msg.chatId, `Got it — I'll remind you in ${duration}.`);
        })
        .catch((err: unknown) => {
          console.error('[main] Failed to enqueue reminder job:', err);
        });
      return;
    }

    const jobIdRaw = `chat:${msg.userId}:${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const jobIdResult = makeJobId(jobIdRaw);
    if (!jobIdResult.ok) {
      console.error(`[main] Failed to create jobId: ${jobIdResult.error}`);
      return;
    }

    const chatJobResult = makeChatJob({
      id: jobIdResult.value,
      userId: userIdResult.value,
      text: msg.text,
      chatId: msg.chatId,
      receivedAt: new Date().toISOString(),
    });

    if (!chatJobResult.ok) {
      console.error(`[main] Failed to create ChatJob: ${chatJobResult.error}`);
      return;
    }

    queues.enqueueChat(chatJobResult.value).catch((err: unknown) => {
      console.error('[main] Failed to enqueue chat job:', err);
    });
  });

  // ── 10. Start workers ──────────────────────────────────────────────────────
  workers.start();

  // ── 11. Start skill watcher — triggers initial load + reconcile ────────────
  skillWatcher.start();

  // ── 12. Start Telegram bot ─────────────────────────────────────────────────
  await telegram.start();

  console.info('[main] Agent started');

  // ── Graceful shutdown ─────────────────────────────────────────────────────

  let isShuttingDown = false;

  const shutdown = async (): Promise<void> => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.info('[main] Shutting down...');
    await Promise.all([
      workers.stop(),
      Promise.resolve(scheduler.stop()),
      skillWatcher.stop(),
      telegram.stop(),
    ]);
    await Promise.all([queues.chat.close(), queues.scheduled.close(), queues.reminder.close()]);
    await disconnectRedis();
    console.info('[main] Shutdown complete');
  };

  const handleSignal = (): void => {
    // Force-exit after 15s if graceful shutdown hangs (e.g. BullMQ/Redis handles keeping event loop alive)
    const forceExitTimer = setTimeout(() => {
      console.error('[main] Force-exiting after shutdown timeout');
      process.exit(1);
    }, 15_000);
    forceExitTimer.unref();

    shutdown()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        console.error('[main] Shutdown error:', err);
        process.exit(1);
      });
  };

  process.once('SIGTERM', handleSignal);
  process.once('SIGINT', handleSignal);

  return shutdown;
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

const isMain =
  typeof Bun !== 'undefined'
    ? Bun.main === import.meta.filename
    : process.argv[1] === new URL(import.meta.url).pathname;

if (isMain) {
  bootstrap().catch((err: unknown) => {
    console.error('[main] Fatal bootstrap error:', err);
    process.exit(1);
  });
}
