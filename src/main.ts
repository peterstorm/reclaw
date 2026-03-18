import { makeTelegramUserId } from './core/types.js';
import { createAsyncMutex } from './core/async-mutex.js';
import { routeMessage } from './orchestration/message-router.js';
import type { AppConfig } from './infra/config.js';
import type { TelegramAdapter } from './infra/telegram.js';
import type { createTelegramAdapter } from './infra/telegram.js';
import type { Queues } from './infra/queue.js';
import type { SkillWatcher } from './infra/skill-watcher.js';
import type { SessionStore } from './infra/session-store.js';
import type { CronScheduler } from './orchestration/scheduler.js';
import type { Workers } from './orchestration/worker.js';
import type { Result, ScheduledJob, ChatJob, JobResult } from './core/types.js';
import type { ResearchJobLike } from './orchestration/research-handler.js';
import type { runClaude, runClaudeStreaming } from './infra/claude-subprocess.js';
import type { handleChatJob } from './orchestration/chat-handler.js';
import type { handleScheduledJob } from './orchestration/scheduled-handler.js';
import type { handleReminderJob, handleRecurringReminderJob } from './orchestration/reminder-handler.js';
import type { handleResearchJob } from './orchestration/research-handler.js';
import type { ResearchDeps } from './orchestration/research-states.js';

// ─── Injectable deps (for testability) ───────────────────────────────────────

export type BootstrapDeps = {
  readonly loadConfigFn?: () => Result<AppConfig, string>;
  readonly createTelegramAdapterFn?: typeof createTelegramAdapter;
  readonly createQueuesFn?: (conn: { host: string; port: number }) => Queues;
  readonly createSkillWatcherFn?: (dir: string) => SkillWatcher;
  readonly createSchedulerFn?: (enq: (job: ScheduledJob) => Promise<void>, isJobKnown: (jobId: string) => Promise<boolean>) => CronScheduler;
  readonly createWorkersFn?: (deps: {
    redisConnection: { host: string; port: number };
    chatHandler: (job: ChatJob) => Promise<JobResult>;
    scheduledHandler: (job: ScheduledJob) => Promise<JobResult>;
    telegram: TelegramAdapter;
    config: AppConfig;
    researchHandler: (job: ResearchJobLike) => Promise<{ hubPath: string | null; topic: string }>;
    reminderHandler: (job: import('./core/types.js').ReminderJob) => Promise<JobResult>;
    recurringReminderHandler: (job: import('./core/types.js').RecurringReminderJob) => Promise<JobResult>;
  }) => Workers;
  readonly runClaudeFn?: typeof runClaude;
  readonly runClaudeStreamingFn?: typeof runClaudeStreaming;
  readonly handleChatJobFn?: typeof handleChatJob;
  readonly handleScheduledJobFn?: typeof handleScheduledJob;
  readonly handleReminderJobFn?: typeof handleReminderJob;
  readonly handleRecurringReminderJobFn?: typeof handleRecurringReminderJob;
  readonly handleResearchJobFn?: typeof handleResearchJob;
  readonly createSessionStoreFn?: (redis: { host: string; port: number }) => {
    sessionStore: SessionStore;
    disconnect: () => Promise<void>;
  };
  readonly createQuotaTrackerFn?: (redis: { host: string; port: number }) => {
    tracker: import('./infra/quota-tracker.js').QuotaTracker;
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

  const createSchedulerFn: (enq: (job: ScheduledJob) => Promise<void>, isJobKnown: (jobId: string) => Promise<boolean>) => CronScheduler =
    injected.createSchedulerFn ??
    (await import('./orchestration/scheduler.js').then((m) => m.createScheduler));

  const workerModule = await import('./orchestration/worker.js');
  const createWorkersFn: typeof workerModule.createWorkers =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (injected.createWorkersFn as any) ?? workerModule.createWorkers;

  const runClaudeFn: typeof runClaude =
    injected.runClaudeFn ??
    (await import('./infra/claude-subprocess.js').then((m) => m.runClaude));

  const runClaudeStreamingFn: typeof runClaudeStreaming =
    injected.runClaudeStreamingFn ??
    (await import('./infra/claude-subprocess.js').then((m) => m.runClaudeStreaming));

  const handleChatJobFn: typeof handleChatJob =
    injected.handleChatJobFn ??
    (await import('./orchestration/chat-handler.js').then((m) => m.handleChatJob));

  const handleScheduledJobFn: typeof handleScheduledJob =
    injected.handleScheduledJobFn ??
    (await import('./orchestration/scheduled-handler.js').then((m) => m.handleScheduledJob));

  const handleReminderJobFn: typeof handleReminderJob =
    injected.handleReminderJobFn ??
    (await import('./orchestration/reminder-handler.js').then((m) => m.handleReminderJob));

  const handleRecurringReminderJobFn: typeof handleRecurringReminderJob =
    injected.handleRecurringReminderJobFn ??
    (await import('./orchestration/reminder-handler.js').then((m) => m.handleRecurringReminderJob));

  const handleResearchJobFn: typeof handleResearchJob =
    injected.handleResearchJobFn ??
    (await import('./orchestration/research-handler.js').then((m) => m.handleResearchJob));

  // ── 1. Load config — exit on failure ─────────────────────────────────────
  const configResult = loadConfigFn();
  if (!configResult.ok) {
    console.error(`[main] Config error: ${configResult.error}`);
    process.exit(1);
  }
  const config = configResult.value;

  console.info('[main] Config loaded');

  // ── 1b. Resolve cortex extraction (always-on, no config needed) ──────────
  const { resolveCortexExtractScript, createCortexExtractor } = await import('./infra/cortex-extract.js');
  const cortexScriptPath = resolveCortexExtractScript();
  const triggerCortexExtraction = cortexScriptPath
    ? createCortexExtractor(cortexScriptPath)
    : undefined;
  if (cortexScriptPath) {
    console.info(`[main] Cortex extraction enabled: ${cortexScriptPath}`);
  } else {
    console.warn('[main] Cortex extraction disabled: script not found');
  }

  // ── 1c. Guard chat runClaude with mutex ──
  // Chat jobs need a mutex to prevent concurrent Claude subprocesses
  // from corrupting shared session state.
  // Scheduled jobs run without a mutex — they spawn independent
  // subprocesses operating on disjoint files, so concurrency is safe.
  const chatMutex = createAsyncMutex();

  const guardedRunClaudeStreamingChat: typeof runClaudeStreamingFn = async (options, onChunk) => {
    const release = await chatMutex.acquire();
    try {
      return await runClaudeStreamingFn(options, onChunk);
    } finally {
      release();
    }
  };

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

  // ── 4. Create shared Redis connection for session store + quota tracker ────
  //    Tests inject their own createSessionStoreFn/createQuotaTrackerFn.
  //    Production uses a single ioredis connection for both.
  let sharedRedis: { quit: () => Promise<string> } | null = null;

  const createSessionStoreFn = injected.createSessionStoreFn ?? (async (redis: { host: string; port: number }) => {
    const { default: Redis } = await import('ioredis');
    const ioredis = new Redis({ host: redis.host, port: redis.port, maxRetriesPerRequest: null });
    sharedRedis = ioredis;
    const { createSessionStore } = await import('./infra/session-store.js');
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
  const scheduler: CronScheduler = createSchedulerFn(queues.enqueueScheduled, queues.isScheduledJobKnown);

  // ── 7. Wire skill watcher onChange to scheduler.reconcile ─────────────────
  skillWatcher.onRegistryChange((registry) => {
    try {
      scheduler.reconcile(registry);
    } catch (err: unknown) {
      console.error('[main] Failed to reconcile scheduler:', err);
    }
  });

  // ── 8a. Lazy-init NotebookLM adapter (AD-5: created on first research job) ─
  let notebookLMAdapter: import('./infra/notebooklm-client.js').NotebookLMAdapter | undefined;

  const getOrCreateNotebookLMAdapter = async (): Promise<import('./infra/notebooklm-client.js').NotebookLMAdapter | null> => {
    if (notebookLMAdapter) return notebookLMAdapter;
    const { createNotebookLMAdapter } = await import('./infra/notebooklm-client.js');
    const hasToken = config.notebooklmAuthToken && config.notebooklmCookies;
    const hasGoogle = config.googleEmail && config.googlePassword;
    if (hasToken) {
      notebookLMAdapter = await createNotebookLMAdapter({
        kind: 'token', authToken: config.notebooklmAuthToken!, cookies: config.notebooklmCookies!,
      });
    } else if (hasGoogle) {
      notebookLMAdapter = await createNotebookLMAdapter({
        kind: 'google', email: config.googleEmail!, password: config.googlePassword!,
      });
    } else {
      console.warn('[main] NotebookLM credentials not configured — research jobs will fail');
      return null;
    }
    return notebookLMAdapter;
  };

  // ── 8b. Create quota tracker using shared Redis connection ─────────────────
  const createQuotaTrackerFn = injected.createQuotaTrackerFn ?? (async (redis: { host: string; port: number }) => {
    // Reuse the shared ioredis connection from session store when available
    const ioredis = sharedRedis as import('ioredis').default | null;
    let quotaRedis: import('ioredis').default;
    if (ioredis) {
      quotaRedis = ioredis;
    } else {
      const { default: Redis } = await import('ioredis');
      quotaRedis = new Redis({ host: redis.host, port: redis.port, maxRetriesPerRequest: null });
    }
    const { createQuotaTracker } = await import('./infra/quota-tracker.js');
    const qtClient: import('./infra/quota-tracker.js').QuotaRedisClient = {
      get: (key) => quotaRedis.get(key),
      set: (key, value, mode, ttlSeconds) => quotaRedis.set(key, value, mode, ttlSeconds),
      incr: (key) => quotaRedis.incr(key),
      incrby: (key, count) => quotaRedis.incrby(key, count),
      expire: (key, ttlSeconds) => quotaRedis.expire(key, ttlSeconds),
    };
    // Don't disconnect here — the shared connection is owned by the session store
    return { tracker: createQuotaTracker(qtClient), disconnect: async () => {} };
  });

  const quotaTracker = await createQuotaTrackerFn({ host: config.redisHost, port: config.redisPort });

  // ── 8c. Create vault writer ───────────────────────────────────────────────
  const vaultWriter = await import('./infra/vault-writer.js').then((m) => m.createVaultWriter());

  // ── 8d. Research LLM adapter ─────────────────────────────────────────────
  const researchLLMAdapter = await import('./infra/research-llm-client.js').then((m) =>
    m.createResearchLLMAdapter(config.workspacePath, 30_000, 600_000),
  );

  // ── 8. Create workers ──────────────────────────────────────────────────────
  const workers: Workers = createWorkersFn({
    redisConnection: { host: config.redisHost, port: config.redisPort },
    chatHandler: (job) => handleChatJobFn(job, { runClaudeStreaming: guardedRunClaudeStreamingChat, telegram, config, sessionStore, ...(triggerCortexExtraction ? { triggerCortexExtraction } : {}) }),
    scheduledHandler: (job) =>
      handleScheduledJobFn(job, {
        runClaude: runClaudeFn,
        telegram,
        skillRegistry: skillWatcher.getRegistry(),
        config,
        sessionStore,
        ...(triggerCortexExtraction ? { triggerCortexExtraction } : {}),
      }),
    reminderHandler: (job) => handleReminderJobFn(job, { telegram }),
    recurringReminderHandler: (job) => handleRecurringReminderJobFn(job, { telegram }),
    researchHandler: async (job) => {
      const notebookLM = await getOrCreateNotebookLMAdapter();
      if (!notebookLM) {
        throw new Error('NotebookLM adapter not configured: set NOTEBOOKLM_AUTH_TOKEN + NOTEBOOKLM_COOKIES, or GOOGLE_EMAIL + GOOGLE_PASSWORD');
      }
      const researchDeps: ResearchDeps = {
        notebookLM,
        researchLLM: researchLLMAdapter,
        vaultWriter,
        telegram,
        quotaTracker: quotaTracker.tracker,
        vaultBasePath: config.obsidianVaultPath ?? config.workspacePath,
        cortexRemember: async (text: string) => {
          const result = await runClaudeFn({
            cwd: config.workspacePath,
            prompt: `Store this research summary in memory for future recall:\n\n${text}`,
            permissionFlags: [],
            timeoutMs: 30_000,
          });
          if (result.ok && result.sessionId && triggerCortexExtraction) {
            triggerCortexExtraction(result.sessionId, config.workspacePath);
          }
        },
      };
      return handleResearchJobFn(job, researchDeps);
    },
    telegram,
    config,
  });

  // ── 9. Wire Telegram onMessage → message router ────────────────────────────
  telegram.onMessage((msg) => routeMessage(msg, {
    telegram,
    sessionStore,
    queues,
    quotaTracker: quotaTracker.tracker,
  }));

  // ── 10. Start skill watcher and wait for initial load ───────────────────────
  // Must complete before workers start so the skill registry is populated
  // when catch-up jobs are processed (prevents "skill not found" race).
  skillWatcher.start();
  await Promise.race([
    skillWatcher.ready(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Skill watcher ready timeout (10s)')), 10_000),
    ),
  ]);

  // ── 10b. Drain stale chat jobs from previous instance ───────────────────
  // Chat jobs are ephemeral user messages — any left in the queue from before
  // this restart are stale (the Claude session they referenced is gone).
  // drain() removes waiting jobs; clean() removes delayed (pending retries)
  // and failed jobs that would otherwise resurrect via BullMQ backoff.
  try {
    await queues.chat.drain();
    await queues.chat.clean(0, 0, 'delayed');
    await queues.chat.clean(0, 0, 'failed');
    console.info('[main] Drained stale chat jobs from previous instance');
  } catch (err: unknown) {
    console.warn('[main] Failed to drain stale chat jobs:', err);
  }

  // ── 11. Start workers ──────────────────────────────────────────────────────
  workers.start();

  // ── 12. Start Telegram bot ─────────────────────────────────────────────────
  await telegram.start();

  // ── 13. Send startup notification to authorized users ─────────────────────
  for (const userId of config.authorizedUserIds) {
    telegram.sendMessage(userId, 'Reclaw restarted and ready.').catch((err: unknown) => {
      console.error('[main] Failed to send startup notification:', err);
    });
  }

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
    await Promise.all([queues.chat.close(), queues.scheduled.close(), queues.reminder.close(), queues.research.close()]);
    await Promise.all([
      disconnectRedis(),
      quotaTracker.disconnect(),
      notebookLMAdapter?.dispose() ?? Promise.resolve(),
    ]);
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
