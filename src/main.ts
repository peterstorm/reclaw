import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Redis } from 'ioredis';
import { formatAgentFailure } from './core/agent-failure.js';
import { createAsyncMutex } from './core/async-mutex.js';
import {
  type ServiceModelSelections,
  resolveModelSelection,
  scheduledModelSelections,
} from './core/model-selection.js';
import { makeTelegramUserId } from './core/types.js';
import type { Result, ScheduledJob, TelegramUserId } from './core/types.js';
import type {
  AgentBackend,
  AgentOptions,
  AgentResult,
  OnStreamChunk,
  runAgent,
} from './infra/agent-backends/index.js';
import type { AppConfig } from './infra/config.js';
import type {
  NotebookLMAdapter,
  NotebookLMCredentials,
  createNotebookLMAdapter,
} from './infra/notebooklm-client.js';
import type { Queues } from './infra/queue.js';
import type { QuotaRedisClient, QuotaTracker } from './infra/quota-tracker.js';
import type { RedisClient, SessionStore } from './infra/session-store.js';
import { sharedRedis } from './infra/shared-redis.js';
import type { SkillQualityRecorder } from './infra/skill-quality.js';
import type { SkillWatcher } from './infra/skill-watcher.js';
import type { TelegramAdapter } from './infra/telegram.js';
import type { createTelegramAdapter } from './infra/telegram.js';
import type { handleChatJob } from './orchestration/chat-handler.js';
import { routeMessage } from './orchestration/message-router.js';
import type { handlePodcastJob } from './orchestration/podcast-handler.js';
import type {
  handleRecurringReminderJob,
  handleReminderJob,
} from './orchestration/reminder-handler.js';
import type { handleResearchJob } from './orchestration/research-handler.js';
import type { handleScheduledJob } from './orchestration/scheduled-handler.js';
import type { CronScheduler } from './orchestration/scheduler.js';
import type { Workers, createWorkers } from './orchestration/worker.js';

// ─── Injectable deps (for testability) ───────────────────────────────────────

type RedisConnection = { host: string; port: number };
type AgentRun = (options: AgentOptions) => Promise<AgentResult>;
type StreamingAgentRun = (options: AgentOptions, onChunk: OnStreamChunk) => Promise<AgentResult>;
type SessionStoreHandle = { sessionStore: SessionStore; disconnect: () => Promise<void> };
type QuotaTrackerHandle = { tracker: QuotaTracker; disconnect: () => Promise<void> };

export type BootstrapDeps = {
  readonly loadConfigFn?: () => Result<AppConfig, string>;
  readonly createTelegramAdapterFn?: typeof createTelegramAdapter;
  readonly createQueuesFn?: (conn: RedisConnection) => Queues;
  readonly createSkillWatcherFn?: (dir: string) => SkillWatcher;
  readonly createSchedulerFn?: (
    enq: (job: ScheduledJob) => Promise<void>,
    isJobKnown: (jobId: string) => Promise<boolean>,
    isJobCompleted: (jobId: string) => Promise<boolean>,
  ) => CronScheduler;
  readonly createWorkersFn?: typeof createWorkers;
  /** Replaces every non-streaming agent run, skipping backend and model resolution. */
  readonly runClaudeFn?: AgentRun;
  readonly runClaudeStreamingFn?: StreamingAgentRun;
  /** The backend runner under backend and model resolution; used when runClaudeFn is not injected. */
  readonly runAgentFn?: typeof runAgent;
  readonly createNotebookLMAdapterFn?: typeof createNotebookLMAdapter;
  readonly handleChatJobFn?: typeof handleChatJob;
  readonly handleScheduledJobFn?: typeof handleScheduledJob;
  readonly handleReminderJobFn?: typeof handleReminderJob;
  readonly handleRecurringReminderJobFn?: typeof handleRecurringReminderJob;
  readonly handleResearchJobFn?: typeof handleResearchJob;
  readonly handlePodcastJobFn?: typeof handlePodcastJob;
  readonly createSessionStoreFn?: (redis: RedisConnection) => SessionStoreHandle;
  readonly createQuotaTrackerFn?: (redis: RedisConnection) => QuotaTrackerHandle;
};

// ─── Wiring types ─────────────────────────────────────────────────────────────

type AdapterFactories = Required<
  Pick<
    BootstrapDeps,
    | 'loadConfigFn'
    | 'createTelegramAdapterFn'
    | 'createQueuesFn'
    | 'createSkillWatcherFn'
    | 'createSchedulerFn'
  >
>;

type JobRuntime = Required<
  Pick<
    BootstrapDeps,
    | 'createWorkersFn'
    | 'handleChatJobFn'
    | 'handleScheduledJobFn'
    | 'handleReminderJobFn'
    | 'handleRecurringReminderJobFn'
    | 'handleResearchJobFn'
    | 'handlePodcastJobFn'
  >
>;

type CortexExtraction = (sessionId: string, cwd: string) => Promise<void>;

type AgentRuntime = {
  readonly runClaude: AgentRun;
  /** Scheduled skills may run on a cheaper/faster Pi model than chat (RECLAW_PI_SCHEDULED_MODEL). */
  readonly runScheduled: AgentRun;
  /** Serialized: chat runs share conversation state. */
  readonly runChatStreaming: StreamingAgentRun;
  readonly triggerCortexExtraction: CortexExtraction | undefined;
  readonly recordSkillQuality: SkillQualityRecorder;
};

/** The stores bootstrap keeps on Redis, and the one way to release them all. */
type RedisStores = {
  readonly sessionStore: SessionStore;
  readonly quotaTracker: QuotaTracker;
  readonly disconnect: () => Promise<void>;
};

/** AD-5: the NotebookLM adapter is created on the first job that needs it, then reused. */
type LazyNotebookLM = {
  readonly get: () => Promise<NotebookLMAdapter | null>;
  readonly dispose: () => Promise<void>;
};

type CreateNotebookLMAdapter = (credentials: NotebookLMCredentials) => Promise<NotebookLMAdapter>;

type NotebookLMConfig = Pick<
  AppConfig,
  'notebooklmAuthToken' | 'notebooklmCookies' | 'googleEmail' | 'googlePassword'
>;

type Components = {
  readonly telegram: TelegramAdapter;
  readonly queues: Queues;
  readonly sessionStore: SessionStore;
  readonly quotaTracker: QuotaTracker;
  /** Releases the session store and the quota tracker, and their shared connection. */
  readonly disconnectRedis: () => Promise<void>;
  readonly skillWatcher: SkillWatcher;
  readonly scheduler: CronScheduler;
  readonly notebookLM: LazyNotebookLM;
};

type WorkerDeps = Parameters<typeof createWorkers>[0];
type NotebookJobHandlers = Pick<WorkerDeps, 'researchHandler' | 'podcastHandler'>;

type FatalErrorRelay = {
  readonly onFatalError: (err: unknown) => void;
  readonly routeTo: (handler: (err: unknown) => void) => void;
};

// ─── Bootstrap ────────────────────────────────────────────────────────────────

// The composition root is process-scoped. Re-bootstrap (notably in tests) must
// replace, not accumulate, top-level listeners.
let activeProcessListenerCleanup: (() => void) | null = null;

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
  const factories = await resolveAdapterFactories(injected);
  const jobs = await resolveJobRuntime(injected);
  const config = await loadAppConfig(factories.loadConfigFn);
  const agents = await createAgentRuntime(config, injected);
  const fatal = createFatalErrorRelay();
  const components = await buildComponents(config, injected, factories, fatal.onFatalError);
  const notebookHandlers = await createNotebookJobHandlers(config, components, agents, jobs);
  const workers = createJobWorkers(config, components, agents, jobs, notebookHandlers);
  routeTelegramMessages(config, components);
  await startServices(config, components, workers);
  return superviseProcess(() => stopServices(components, workers), fatal);
}

// ─── Dependency resolution ───────────────────────────────────────────────────

async function resolveAdapterFactories(
  injected: Partial<AdapterFactories>,
): Promise<AdapterFactories> {
  return {
    loadConfigFn:
      injected.loadConfigFn ?? (await import('./infra/config.js').then((m) => m.loadConfig)),
    createTelegramAdapterFn:
      injected.createTelegramAdapterFn ??
      (await import('./infra/telegram.js').then((m) => m.createTelegramAdapter)),
    createQueuesFn:
      injected.createQueuesFn ?? (await import('./infra/queue.js').then((m) => m.createQueues)),
    createSkillWatcherFn:
      injected.createSkillWatcherFn ??
      (await import('./infra/skill-watcher.js').then((m) => m.createSkillWatcher)),
    createSchedulerFn:
      injected.createSchedulerFn ??
      (await import('./orchestration/scheduler.js').then((m) => m.createScheduler)),
  };
}

async function resolveJobRuntime(injected: Partial<JobRuntime>): Promise<JobRuntime> {
  const workerModule = await import('./orchestration/worker.js');
  return {
    createWorkersFn: injected.createWorkersFn ?? workerModule.createWorkers,
    handleChatJobFn:
      injected.handleChatJobFn ??
      (await import('./orchestration/chat-handler.js').then((m) => m.handleChatJob)),
    handleScheduledJobFn:
      injected.handleScheduledJobFn ??
      (await import('./orchestration/scheduled-handler.js').then((m) => m.handleScheduledJob)),
    handleReminderJobFn:
      injected.handleReminderJobFn ??
      (await import('./orchestration/reminder-handler.js').then((m) => m.handleReminderJob)),
    handleRecurringReminderJobFn:
      injected.handleRecurringReminderJobFn ??
      (await import('./orchestration/reminder-handler.js').then(
        (m) => m.handleRecurringReminderJob,
      )),
    handleResearchJobFn:
      injected.handleResearchJobFn ??
      (await import('./orchestration/research-handler.js').then((m) => m.handleResearchJob)),
    handlePodcastJobFn:
      injected.handlePodcastJobFn ??
      (await import('./orchestration/podcast-handler.js').then((m) => m.handlePodcastJob)),
  };
}

/** Load config — exit on failure. */
async function loadAppConfig(loadConfigFn: () => Result<AppConfig, string>): Promise<AppConfig> {
  const configResult = loadConfigFn();
  if (!configResult.ok) {
    console.error(`[main] Config error: ${configResult.error}`);
    process.exit(1);
  }
  const loadedConfig = configResult.value;
  // Fill in scriptsDir (for {{scriptsDir}} in skill templates) from the running
  // module's location when SCRIPTS_DIR isn't set, so skills never hardcode a checkout path.
  const { resolveScriptsDir } = await import('./infra/config.js');
  const config: AppConfig = {
    ...loadedConfig,
    scriptsDir: loadedConfig.scriptsDir ?? resolveScriptsDir(),
  };
  console.info(`[main] Config loaded (scriptsDir: ${config.scriptsDir})`);
  return config;
}

// ─── Agent runs ───────────────────────────────────────────────────────────────

type AgentRunnerConfig = Pick<
  AppConfig,
  'agentBackend' | 'agentContainment' | 'piProvider' | 'piModel' | 'piScheduledModel'
>;
type InjectedAgentRunners = Pick<
  BootstrapDeps,
  'runClaudeFn' | 'runClaudeStreamingFn' | 'runAgentFn'
>;

async function createAgentRuntime(
  config: AgentRunnerConfig,
  injected: InjectedAgentRunners,
): Promise<AgentRuntime> {
  const runners = await createAgentRunners(config, injected);
  const triggerCortexExtraction = await createCortexExtraction();
  const recordSkillQuality = await openSkillQualityLog();
  return { ...runners, triggerCortexExtraction, recordSkillQuality };
}

async function createAgentRunners(
  config: AgentRunnerConfig,
  injected: InjectedAgentRunners,
): Promise<Pick<AgentRuntime, 'runClaude' | 'runScheduled' | 'runChatStreaming'>> {
  const { resolveBackend, runAgent, runAgentStreaming } = await import(
    './infra/agent-backends/index.js'
  );
  console.info(`[main] Agent backend: ${resolveBackend(config).name}`);
  console.info(describeContainment(config.agentContainment));

  // Resolve the backend first, then the model for THAT backend — the Pi defaults must never
  // reach a Claude run (a per-skill `backend: claude` would otherwise get `--model <vLLM id>`).
  // Every agent run (chat, scheduled, research) passes through here, so this is
  // also where each run gets the service's containment.
  const forBackend =
    (defaults: ServiceModelSelections) =>
    (opts: AgentOptions): [AgentBackend, AgentOptions] => {
      const backend = opts.backend ?? config.agentBackend;
      const { modelSelection: requested, ...rest } = opts;
      const modelSelection = resolveModelSelection(backend, requested, defaults);
      const contained = { ...rest, containment: config.agentContainment };
      return [
        resolveBackend({ agentBackend: backend }),
        modelSelection ? { ...contained, modelSelection } : contained,
      ];
    };

  const serviceSelections = piModelSelections(config);
  const scheduledSelections = scheduledModelSelections(serviceSelections, config.piScheduledModel);
  const runStreaming: StreamingAgentRun =
    injected.runClaudeStreamingFn ??
    ((opts, onChunk) => runAgentStreaming(...forBackend(serviceSelections)(opts), onChunk));
  const run = injected.runAgentFn ?? runAgent;
  return {
    runClaude: injected.runClaudeFn ?? ((opts) => run(...forBackend(serviceSelections)(opts))),
    runScheduled: injected.runClaudeFn ?? ((opts) => run(...forBackend(scheduledSelections)(opts))),
    runChatStreaming: serialized(runStreaming),
  };
}

/** The service-wide Pi defaults (RECLAW_PI_PROVIDER / RECLAW_PI_MODEL); empty when neither is set. */
function piModelSelections(
  config: Pick<AppConfig, 'piProvider' | 'piModel'>,
): ServiceModelSelections {
  if (config.piProvider === undefined && config.piModel === undefined) return {};
  return {
    pi: {
      ...(config.piProvider !== undefined ? { provider: config.piProvider } : {}),
      ...(config.piModel !== undefined ? { model: config.piModel } : {}),
    },
  };
}

function describeContainment(containment: AgentRunnerConfig['agentContainment']): string {
  return containment.kind === 'systemd-scope'
    ? `[main] Agent containment: systemd scope per run in ${containment.slice} (bindsTo=${containment.bindsTo ?? 'none'}, runtimeMaxSec=${containment.runtimeMaxSec})`
    : '[main] Agent containment: none — a timed-out run only signals the agent process';
}

/**
 * Serialize backend-neutral chat agent runs that share conversation state.
 * Scheduled jobs run independently on disjoint activity/session lineages.
 */
function serialized(run: StreamingAgentRun): StreamingAgentRun {
  const mutex = createAsyncMutex();
  return async (options, onChunk) => {
    const release = await mutex.acquire();
    try {
      return await run(options, onChunk);
    } finally {
      release();
    }
  };
}

/** Cortex extraction is always on when its script is installed; no config needed. */
async function createCortexExtraction(): Promise<CortexExtraction | undefined> {
  const { resolveCortexExtractScript, createCortexExtractor } = await import(
    './infra/cortex-extract.js'
  );
  const scriptPath = resolveCortexExtractScript();
  if (!scriptPath) {
    console.warn('[main] Cortex extraction disabled: script not found');
    return undefined;
  }
  console.info(`[main] Cortex extraction enabled: ${scriptPath}`);
  return createCortexExtractor(scriptPath);
}

async function openSkillQualityLog(): Promise<SkillQualityRecorder> {
  const { createSkillQualityRecorder } = await import('./infra/skill-quality.js');
  const logPath = join(homedir(), '.cache', 'reclaw', 'skill-quality.jsonl');
  const recorder = createSkillQualityRecorder(logPath);
  console.info(`[main] Skill quality recorder enabled: ${logPath}`);
  return recorder;
}

// ─── Components ───────────────────────────────────────────────────────────────

type ComponentConfig = NotebookLMConfig &
  Pick<
    AppConfig,
    'telegramToken' | 'authorizedUserIds' | 'redisHost' | 'redisPort' | 'skillsDir' | 'agentBackend'
  >;
type InjectedComponents = Pick<
  BootstrapDeps,
  'createSessionStoreFn' | 'createQuotaTrackerFn' | 'createNotebookLMAdapterFn'
>;

async function buildComponents(
  config: ComponentConfig,
  injected: InjectedComponents,
  factories: Omit<AdapterFactories, 'loadConfigFn'>,
  onFatalError: (err: unknown) => void,
): Promise<Components> {
  const connection: RedisConnection = { host: config.redisHost, port: config.redisPort };
  const telegram = factories.createTelegramAdapterFn({
    token: config.telegramToken,
    authorizedUserIds: parseAuthorizedUserIds(config.authorizedUserIds),
    onFatalError,
  });
  const queues = factories.createQueuesFn(connection);
  const redisStores = await openRedisStores(injected, connection, config.agentBackend);
  console.info('[main] Session store created');
  const skillWatcher = factories.createSkillWatcherFn(config.skillsDir);
  const scheduler = factories.createSchedulerFn(
    queues.enqueueScheduled,
    queues.isScheduledJobKnown,
    queues.isScheduledJobCompleted,
  );
  reconcileOnRegistryChange(skillWatcher, scheduler);
  return {
    telegram,
    queues,
    sessionStore: redisStores.sessionStore,
    quotaTracker: redisStores.quotaTracker,
    disconnectRedis: redisStores.disconnect,
    skillWatcher,
    scheduler,
    notebookLM: lazyNotebookLM(config, injected.createNotebookLMAdapterFn ?? loadNotebookLMAdapter),
  };
}

/** Exits on the first invalid id: Telegram must never run with a partial allow-list. */
function parseAuthorizedUserIds(rawIds: readonly number[]): TelegramUserId[] {
  return rawIds.map((rawId) => {
    const parsed = makeTelegramUserId(rawId);
    if (!parsed.ok) {
      console.error(`[main] Invalid authorizedUserIds entry: ${parsed.error}`);
      process.exit(1);
    }
    return parsed.value;
  });
}

/**
 * Production shares one ioredis connection between the session store and the quota
 * tracker. Its SharedRedis handle opens it only for a store whose factory is not
 * injected, and closes it once at shutdown. An injected store brings its own disconnect.
 */
async function openRedisStores(
  injected: Pick<BootstrapDeps, 'createSessionStoreFn' | 'createQuotaTrackerFn'>,
  connection: RedisConnection,
  backend: AppConfig['agentBackend'],
): Promise<RedisStores> {
  const redis = sharedRedis(() => connectRedis(connection));
  const injectedSession = injected.createSessionStoreFn?.(connection);
  const injectedQuota = injected.createQuotaTrackerFn?.(connection);
  return {
    sessionStore:
      injectedSession?.sessionStore ?? (await sessionStoreOn(await redis.client(), backend)),
    quotaTracker: injectedQuota?.tracker ?? (await quotaTrackerOn(await redis.client())),
    disconnect: async () => {
      await Promise.all([
        injectedSession?.disconnect(),
        injectedQuota?.disconnect(),
        redis.close(),
      ]);
    },
  };
}

async function connectRedis(connection: RedisConnection): Promise<Redis> {
  const { default: RedisClientCtor } = await import('ioredis');
  return new RedisClientCtor({ ...connection, maxRetriesPerRequest: null });
}

async function sessionStoreOn(
  redis: Redis,
  backend: AppConfig['agentBackend'],
): Promise<SessionStore> {
  const { createSessionStore } = await import('./infra/session-store.js');
  const client: RedisClient = {
    get: (key) => redis.get(key),
    set: (key, value, options) =>
      options?.PX ? redis.set(key, value, 'PX', options.PX) : redis.set(key, value),
    del: (key) => redis.del(key),
    eval: (script, numberOfKeys, ...args) => redis.eval(script, numberOfKeys, ...args),
  };
  return createSessionStore(client, backend);
}

async function quotaTrackerOn(redis: Redis): Promise<QuotaTracker> {
  const { createQuotaTracker } = await import('./infra/quota-tracker.js');
  const client: QuotaRedisClient = {
    get: (key) => redis.get(key),
    set: (key, value, mode, ttlSeconds) => redis.set(key, value, mode, ttlSeconds),
    incrby: (key, count) => redis.incrby(key, count),
    expire: (key, ttlSeconds) => redis.expire(key, ttlSeconds),
  };
  return createQuotaTracker(client);
}

function reconcileOnRegistryChange(skillWatcher: SkillWatcher, scheduler: CronScheduler): void {
  skillWatcher.onRegistryChange((registry) => {
    try {
      scheduler.reconcile(registry);
    } catch (err: unknown) {
      console.error('[main] Failed to reconcile scheduler:', err);
    }
  });
}

const NOTEBOOKLM_AUTH_LOG: Readonly<Record<NotebookLMCredentials['kind'], string>> = {
  token: '[main] Initializing NotebookLM adapter with token auth...',
  google: '[main] Initializing NotebookLM adapter with Google auto-login...',
};

const loadNotebookLMAdapter: CreateNotebookLMAdapter = (credentials) =>
  import('./infra/notebooklm-client.js').then((m) => m.createNotebookLMAdapter(credentials));

/** Token auth wins over Google auto-login; null when neither pair is complete. */
function notebookLMCredentials(config: NotebookLMConfig): NotebookLMCredentials | null {
  const { notebooklmAuthToken: authToken, notebooklmCookies: cookies } = config;
  const { googleEmail: email, googlePassword: password } = config;
  if (authToken && cookies) return { kind: 'token', authToken, cookies };
  if (email && password) return { kind: 'google', email, password };
  return null;
}

/**
 * Concurrent first calls share one in-flight creation, so exactly one adapter exists
 * and `dispose` reaches it. A failed creation is forgotten: the next job tries again.
 */
function lazyNotebookLM(config: NotebookLMConfig, create: CreateNotebookLMAdapter): LazyNotebookLM {
  let creation: Promise<NotebookLMAdapter> | null = null;
  const connect = async (credentials: NotebookLMCredentials): Promise<NotebookLMAdapter> => {
    console.info(NOTEBOOKLM_AUTH_LOG[credentials.kind]);
    const adapter = await create(credentials);
    console.info('[main] NotebookLM adapter initialized successfully');
    return adapter;
  };
  return {
    get: async () => {
      const credentials = notebookLMCredentials(config);
      if (credentials === null) {
        console.warn('[main] NotebookLM credentials not configured — research jobs will fail');
        return null;
      }
      creation ??= connect(credentials).catch((err: unknown) => {
        creation = null;
        throw err;
      });
      return creation;
    },
    dispose: async () => {
      // A failed creation already rejected the job that awaited it, and left nothing to dispose.
      const adapter = await creation?.catch(() => null);
      await adapter?.dispose();
    },
  };
}

async function requireNotebookLM(notebookLM: LazyNotebookLM): Promise<NotebookLMAdapter> {
  const adapter = await notebookLM.get();
  if (!adapter) {
    throw new Error(
      'NotebookLM adapter not configured: set NOTEBOOKLM_AUTH_TOKEN + NOTEBOOKLM_COOKIES, or GOOGLE_EMAIL + GOOGLE_PASSWORD',
    );
  }
  return adapter;
}

// ─── Workers ──────────────────────────────────────────────────────────────────

function createJobWorkers(
  config: AppConfig,
  components: Pick<
    Components,
    'telegram' | 'sessionStore' | 'queues' | 'skillWatcher' | 'scheduler'
  >,
  agents: Pick<
    AgentRuntime,
    'runChatStreaming' | 'runScheduled' | 'recordSkillQuality' | 'triggerCortexExtraction'
  >,
  jobs: Omit<JobRuntime, 'handleResearchJobFn' | 'handlePodcastJobFn'>,
  notebookHandlers: NotebookJobHandlers,
): Workers {
  const { telegram, sessionStore, queues, skillWatcher, scheduler } = components;
  const { triggerCortexExtraction } = agents;
  return jobs.createWorkersFn({
    redisConnection: { host: config.redisHost, port: config.redisPort },
    chatHandler: (job) =>
      jobs.handleChatJobFn(job, {
        runClaudeStreaming: agents.runChatStreaming,
        telegram,
        config,
        sessionStore,
      }),
    scheduledHandler: (job) =>
      jobs.handleScheduledJobFn(job, {
        runClaude: agents.runScheduled,
        telegram,
        skillRegistry: skillWatcher.getRegistry(),
        config,
        processEnvironment: process.env,
        sessionStore,
        recordSkillQuality: agents.recordSkillQuality,
        completionMode: 'durable',
      }),
    reminderHandler: (job) => jobs.handleReminderJobFn(job, { telegram }),
    recurringReminderHandler: (job) => jobs.handleRecurringReminderJobFn(job, { telegram }),
    ...notebookHandlers,
    telegram,
    sessionStore,
    activityResults: queues.activityResults,
    deliveryOutbox: queues.deliveryOutbox,
    ...(triggerCortexExtraction ? { triggerCortexExtraction } : {}),
    config,
    onScheduledJobCompleted: (job) => scheduler.resolveDependents(job.skillId, job.triggeredAt),
    markScheduledJobCompleted: (jobId) => queues.markScheduledJobCompleted(jobId),
    now: () => new Date(),
  });
}

type ResearchMemoryAgents = Pick<AgentRuntime, 'runClaude' | 'triggerCortexExtraction'>;

/** Research and podcast jobs both need NotebookLM; each job fails when it is not configured. */
async function createNotebookJobHandlers(
  config: Pick<AppConfig, 'workspacePath' | 'obsidianVaultPath'>,
  components: Pick<Components, 'telegram' | 'notebookLM' | 'quotaTracker'>,
  agents: ResearchMemoryAgents,
  jobs: Pick<JobRuntime, 'handleResearchJobFn' | 'handlePodcastJobFn'>,
): Promise<NotebookJobHandlers> {
  const vaultWriter = await import('./infra/vault-writer.js').then((m) => m.createVaultWriter());
  const researchLLM = await import('./infra/research-llm-client.js').then((m) =>
    m.createResearchLLMAdapter(config.workspacePath, 30_000, 600_000, agents.runClaude),
  );
  const { telegram, notebookLM, quotaTracker } = components;
  const vaultBasePath = config.obsidianVaultPath ?? config.workspacePath;
  return {
    researchHandler: async (job) =>
      jobs.handleResearchJobFn(job, {
        notebookLM: await requireNotebookLM(notebookLM),
        researchLLM,
        vaultWriter,
        telegram,
        quotaTracker,
        vaultBasePath,
        cortexRemember: rememberResearchSummary(config.workspacePath, agents),
      }),
    podcastHandler: async (job) =>
      jobs.handlePodcastJobFn(job, {
        notebookLM: await requireNotebookLM(notebookLM),
        telegram,
        vaultBasePath,
      }),
  };
}

function rememberResearchSummary(
  workspacePath: string,
  agents: ResearchMemoryAgents,
): (text: string) => Promise<void> {
  return async (text) => {
    const result = await agents.runClaude({
      cwd: workspacePath,
      prompt: `Store this research summary in memory for future recall:\n\n${text}`,
      allowedTools: [],
      timeoutMs: 30_000,
    });
    if (!result.ok) {
      console.warn(
        `[main] Research memory-summary agent failed: ${formatAgentFailure(result.failure)}`,
      );
    } else if (result.sessionId && agents.triggerCortexExtraction) {
      await agents.triggerCortexExtraction(result.sessionId, workspacePath);
    }
  };
}

// ─── Ingress and startup ──────────────────────────────────────────────────────

/**
 * The returned promise is the durable ingress boundary. A rejection stops
 * polling without acknowledging the update, so Telegram can redeliver it.
 */
function routeTelegramMessages(
  config: Pick<AppConfig, 'agentBackend' | 'obsidianVaultPath' | 'workspacePath'>,
  components: Pick<
    Components,
    'telegram' | 'sessionStore' | 'queues' | 'quotaTracker' | 'skillWatcher' | 'notebookLM'
  >,
): void {
  const { telegram, sessionStore, queues, quotaTracker, skillWatcher, notebookLM } = components;
  telegram.onMessage((msg) =>
    routeMessage(msg, {
      telegram,
      sessionStore,
      queues,
      quotaTracker,
      agentBackend: config.agentBackend,
      getSkillRegistry: skillWatcher.getRegistry,
      getNotebookLM: notebookLM.get,
      vaultBasePath: config.obsidianVaultPath ?? config.workspacePath,
    }),
  );
}

async function startServices(
  config: Pick<AppConfig, 'authorizedUserIds'>,
  { skillWatcher, telegram }: Pick<Components, 'skillWatcher' | 'telegram'>,
  workers: Workers,
): Promise<void> {
  await loadSkillRegistry(skillWatcher);

  // Accepted chat jobs are durable work and survive process restarts. Never
  // drain them during startup; stable Telegram update IDs deduplicate replay.

  // Workers were constructed with autorun:false. Do not open Telegram ingress
  // until every BullMQ connection is ready and every run loop has been started.
  await workers.start();
  console.info('[main] Workers ready');

  await telegram.start();
  announceRestart(telegram, config.authorizedUserIds);
  console.info('[main] Agent started');
}

/**
 * Must complete before workers start so the skill registry is populated
 * when catch-up jobs are processed (prevents "skill not found" race).
 */
async function loadSkillRegistry(skillWatcher: SkillWatcher): Promise<void> {
  skillWatcher.start();
  await Promise.race([
    skillWatcher.ready(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Skill watcher ready timeout (10s)')), 10_000),
    ),
  ]);
}

function announceRestart(telegram: TelegramAdapter, userIds: readonly number[]): void {
  for (const userId of userIds) {
    telegram.sendMessage(userId, 'Reclaw restarted and ready.').catch((err: unknown) => {
      console.error('[main] Failed to send startup notification:', err);
    });
  }
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

/**
 * Close ingress and producers first, then drain active workers, then close
 * queue connections. This prevents new work from arriving behind a worker
 * that has already begun shutdown.
 */
async function stopServices(
  components: Pick<
    Components,
    'scheduler' | 'skillWatcher' | 'telegram' | 'queues' | 'disconnectRedis' | 'notebookLM'
  >,
  workers: Workers,
): Promise<void> {
  const { scheduler, skillWatcher, telegram, queues } = components;
  await Promise.all([Promise.resolve(scheduler.stop()), skillWatcher.stop(), telegram.stop()]);
  await workers.stop();
  await Promise.all([
    queues.chat.close(),
    queues.scheduled.close(),
    queues.reminder.close(),
    queues.research.close(),
    queues.podcast.close(),
    queues.delivery.close(),
  ]);
  await Promise.all([components.disconnectRedis(), components.notebookLM.dispose()]);
}

/**
 * Forward reference: a fatal Telegram polling failure routes through the same
 * graceful-shutdown path as SIGTERM once `routeTo` wires it. Until then (polling
 * died before bootstrap finished) it exits.
 */
function createFatalErrorRelay(): FatalErrorRelay {
  let handle = (err: unknown): void => {
    console.error('[main] Telegram polling failed before shutdown was wired — exiting:', err);
    process.exit(1);
  };
  return {
    onFatalError: (err) => handle(err),
    routeTo: (handler) => {
      handle = handler;
    },
  };
}

/** Wires signals and fatal errors to one shared shutdown, and returns it. */
function superviseProcess(stop: () => Promise<void>, fatal: FatalErrorRelay): () => Promise<void> {
  const shutdown = once(async () => {
    releaseProcessListeners(removeProcessListeners);
    console.info('[main] Shutting down...');
    await stop();
    console.info('[main] Shutdown complete');
  });
  const handleSignal = exitAfterShutdown(shutdown);
  // A fatal Telegram polling failure now drains queues and closes Redis like any
  // other shutdown, rather than the adapter calling process.exit() mid-flight.
  fatal.routeTo((err) => {
    console.error('[main] Telegram polling failed fatally — initiating graceful shutdown:', err);
    handleSignal();
  });
  const removeProcessListeners = installProcessListeners(handleSignal);
  return shutdown;
}

/** Concurrent and repeated calls share the first call's completion promise. */
function once(run: () => Promise<void>): () => Promise<void> {
  let started: Promise<void> | null = null;
  return () => {
    started ??= run();
    return started;
  };
}

function exitAfterShutdown(shutdown: () => Promise<void>): () => void {
  return () => {
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
}

// Top-level error handlers — without these, an unhandled rejection from any
// of the dozens of `.catch` chains (or a top-level await throw) tears the
// process down with whatever Node prints by default. systemd then crash-loops
// until StartLimitBurst (5 in 5min) trips. Log these explicitly so the cause
// survives in journalctl.
function exitOnUncaughtException(err: unknown): void {
  console.error('[main] uncaughtException — exiting:', err);
  process.exit(1);
}

function logUnhandledRejection(reason: unknown): void {
  console.error('[main] unhandledRejection:', reason);
  // Don't exit — this is recoverable; SIGTERM-driven shutdown still works.
}

/** Replaces the previous bootstrap's listeners and returns the remover for these. */
function installProcessListeners(handleSignal: () => void): () => void {
  const removeProcessListeners = (): void => {
    process.off('SIGTERM', handleSignal);
    process.off('SIGINT', handleSignal);
    process.off('uncaughtException', exitOnUncaughtException);
    process.off('unhandledRejection', logUnhandledRejection);
  };
  activeProcessListenerCleanup?.();
  process.once('SIGTERM', handleSignal);
  process.once('SIGINT', handleSignal);
  process.on('uncaughtException', exitOnUncaughtException);
  process.on('unhandledRejection', logUnhandledRejection);
  activeProcessListenerCleanup = removeProcessListeners;
  return removeProcessListeners;
}

/** Removes the listeners only while they are still the active ones. */
function releaseProcessListeners(removeProcessListeners: () => void): void {
  if (activeProcessListenerCleanup !== removeProcessListeners) return;
  removeProcessListeners();
  activeProcessListenerCleanup = null;
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
