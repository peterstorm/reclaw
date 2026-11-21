import { UnrecoverableError } from 'bullmq';
import {
  type ActivityId,
  type ActivityKind,
  type ActivityResult,
  type ActivityResultRepository,
  type CortexDelivery,
  type DeliveryJob,
  type DeliveryOutbox,
  type TelegramDeliveryOperation,
  makeActivityId,
  makeChatSessionDelivery,
  makeCortexDelivery,
  makeFileCleanupDelivery,
  makeTelegramBatchDelivery,
} from '../core/activity.js';
import {
  type AgentFailure,
  agentFailurePolicy,
  formatAgentFailure,
} from '../core/agent-failure.js';
import { parseChatJob, parseScheduledJob } from '../core/job-schemas.js';
import { splitMessage } from '../core/message-splitter.js';
import {
  type AgentSessionId,
  type ChatJob,
  type ScheduledJob,
  chatJobSourcePaths,
} from '../core/types.js';
import type { AppConfig } from '../infra/config.js';
import type { SessionStore } from '../infra/session-store.js';
import { removeSpooledFile } from '../infra/telegram.js';
import type { ChatActivityOutcome } from './chat-handler.js';
import type { ScheduledActivityOutcome } from './scheduled-handler.js';

// The two queues whose source jobs run an expensive agent activity. Each one
// persists an immutable ActivityResult before any side effect, so a retry after
// a later failure reuses the result instead of running the agent again.

// ─── Types ────────────────────────────────────────────────────────────────────

/** The part of a BullMQ job an activity processor reads. */
type SourceJob = { readonly data: unknown; readonly id?: string };

/** What both activity queues need: result persistence, the outbox, cortex wiring and a clock. */
type ActivityQueueDeps = {
  readonly activityResults: ActivityResultRepository;
  readonly deliveryOutbox: DeliveryOutbox;
  readonly triggerCortexExtraction?: (sessionId: string, cwd: string) => Promise<void>;
  readonly config: Pick<AppConfig, 'workspacePath'>;
  /** Read once per recorded activity: every timestamp it persists is the same instant. */
  readonly now: () => Date;
};

export type ChatQueueDeps = ActivityQueueDeps & {
  readonly chatHandler: (job: ChatJob) => Promise<ChatActivityOutcome>;
  readonly sessionStore: SessionStore;
};

export type ScheduledQueueDeps = ActivityQueueDeps & {
  readonly scheduledHandler: (job: ScheduledJob) => Promise<ScheduledActivityOutcome>;
  readonly config: Pick<AppConfig, 'authorizedUserIds'>;
  /** Called when a scheduled job completes successfully — triggers dependent resolution. */
  readonly onScheduledJobCompleted: (job: ScheduledJob) => Promise<void>;
  /** Sets a Redis completion marker for catch-up crash recovery. */
  readonly markScheduledJobCompleted: (jobId: string) => Promise<void>;
};

type CompletedChat = Extract<ChatActivityOutcome, { readonly kind: 'completed' }>;
type CompletedScheduled = Extract<ScheduledActivityOutcome, { readonly kind: 'completed' }>;
type SkippedScheduled = Extract<ScheduledActivityOutcome, { readonly kind: 'skipped' }>;

/** A chat activity this attempt ran, or one an earlier attempt already persisted. */
type ChatRecord =
  | { readonly kind: 'reused'; readonly activity: ActivityResult }
  | {
      readonly kind: 'recorded';
      readonly activity: ActivityResult;
      readonly drainPreviews: () => Promise<void>;
    };

/**
 * A scheduled activity this attempt ran, one an earlier attempt already persisted, or a skip.
 * A skip is a successful non-event: no activity ran, so nothing is persisted.
 */
type ScheduledRecord =
  | { readonly kind: 'reused'; readonly activity: ActivityResult }
  | { readonly kind: 'recorded'; readonly activity: ActivityResult }
  | { readonly kind: 'skipped'; readonly outcome: SkippedScheduled };

// ─── Retry semantics ──────────────────────────────────────────────────────────

/** Throw an agent failure so BullMQ retries it only when the policy allows. */
function throwAgentFailure(failure: AgentFailure): never {
  const message = formatAgentFailure(failure);
  if (!agentFailurePolicy(failure).retryable) {
    throw new UnrecoverableError(message);
  }
  throw new Error(message);
}

function assertActivityIdentity(activity: ActivityResult, kind: ActivityKind, jobId: string): void {
  if (activity.sourceKind !== kind || activity.outcome.kind !== `${kind}-completed`) {
    throw new Error(`Activity identity collision for ${kind} job ${jobId}`);
  }
}

// ─── Delivery plans (pure) ────────────────────────────────────────────────────

/** Cortex extraction runs only when a session exists and extraction is wired in. */
const cortexWorkspace = (deps: ActivityQueueDeps): string | null =>
  deps.triggerCortexExtraction === undefined ? null : deps.config.workspacePath;

function cortexDeliveries(
  activityId: ActivityId,
  sessionId: AgentSessionId | null,
  cwd: string | null,
): readonly CortexDelivery[] {
  return sessionId === null || cwd === null
    ? []
    : [makeCortexDelivery({ activityId, sessionId, cwd })];
}

function chatDeliveries(
  activityId: ActivityId,
  chatId: number,
  outcome: CompletedChat,
  cortexCwd: string | null,
  lastActivityAt: string,
): readonly DeliveryJob[] {
  const session =
    outcome.sessionId === null
      ? null
      : { backend: outcome.conversationBackend, sessionId: outcome.sessionId };
  return [
    ...(session === null
      ? []
      : [
          makeChatSessionDelivery({
            activityId,
            chatId,
            expectedGeneration: outcome.conversationGeneration,
            expectedRevision: outcome.conversationRevision,
            backend: session.backend,
            sessionId: session.sessionId,
            lastActivityAt,
          }),
        ]),
    ...(outcome.telegramOperations.length === 0
      ? []
      : [
          makeTelegramBatchDelivery({
            activityId,
            chatId,
            operations: outcome.telegramOperations,
            conversationReference: session,
          }),
        ]),
    ...cortexDeliveries(activityId, outcome.sessionId, cortexCwd),
    ...(outcome.sourcePaths.length === 0
      ? []
      : [makeFileCleanupDelivery({ activityId, paths: outcome.sourcePaths })]),
  ];
}

/** FR-005: a non-suppressed scheduled response goes to every recipient's chat. */
function scheduledDeliveries(
  activityId: ActivityId,
  recipients: readonly number[],
  outcome: CompletedScheduled,
  cortexCwd: string | null,
): readonly DeliveryJob[] {
  const chunks = outcome.suppressed ? [] : splitMessage(outcome.response);
  const operations = chunks.map(
    (text): TelegramDeliveryOperation => ({ kind: 'send', text, format: 'markdown' }),
  );
  const conversationReference =
    outcome.session === null
      ? null
      : { backend: outcome.session.backend, sessionId: outcome.session.sessionId };
  return [
    ...(chunks.length === 0
      ? []
      : recipients.map((chatId) =>
          makeTelegramBatchDelivery({ activityId, chatId, operations, conversationReference }),
        )),
    ...cortexDeliveries(activityId, outcome.session?.sessionId ?? null, cortexCwd),
  ];
}

// ─── Chat queue ───────────────────────────────────────────────────────────────

async function removeChatSourceFiles(chatJob: ChatJob): Promise<void> {
  await Promise.all(chatJobSourcePaths(chatJob).map((path) => removeSpooledFile(path)));
}

/** Dead-letter cleanup: remove a chat job's spooled attachments after its final attempt. */
export async function removeFailedChatSources(data: unknown): Promise<void> {
  const parsed = parseChatJob(data);
  if (!parsed.ok) return;
  await removeChatSourceFiles(parsed.value);
}

async function recordChatActivity(deps: ChatQueueDeps, chatJob: ChatJob): Promise<ChatRecord> {
  const activityId = makeActivityId('chat', chatJob.id);
  const existing = await deps.activityResults.find(activityId);
  if (existing !== null) return { kind: 'reused', activity: existing };

  const outcome = await deps.chatHandler(chatJob);
  if (outcome.kind === 'failed') {
    throwAgentFailure(outcome.failure);
  }
  const completedAt = deps.now().toISOString();
  const deliveries = chatDeliveries(
    activityId,
    chatJob.chatId,
    outcome,
    cortexWorkspace(deps),
    completedAt,
  );
  const activity = await deps.activityResults.saveIfAbsent({
    schemaVersion: 1,
    id: activityId,
    sourceKind: 'chat',
    sourceJobId: chatJob.id,
    completedAt,
    outcome: { kind: 'chat-completed', response: outcome.response },
    deliveries,
  });
  return { kind: 'recorded', activity, drainPreviews: outcome.drainPreviews };
}

/**
 * The next serialized chat job may start as soon as this processor returns, so
 * conversation state is a critical CAS commit. Generation and revision prevent
 * /new or a delayed older delivery from overwriting the selected lineage.
 */
async function commitChatSessions(
  sessionStore: SessionStore,
  deliveries: readonly DeliveryJob[],
): Promise<void> {
  for (const delivery of deliveries) {
    if (delivery.kind === 'chat-session' && delivery.schemaVersion === 2) {
      await sessionStore.commitSession({
        chatId: delivery.chatId,
        expectedGeneration: delivery.expectedGeneration,
        expectedRevision: delivery.expectedRevision,
        backend: delivery.backend,
        sessionId: delivery.sessionId,
        lastActivityAt: delivery.lastActivityAt,
      });
    }
  }
}

export function processChatJob(deps: ChatQueueDeps) {
  return async (job: SourceJob): Promise<ActivityResult['outcome']> => {
    const parsed = parseChatJob(job.data);
    if (!parsed.ok) throw new Error(parsed.error);
    const chatJob = parsed.value;
    console.info(
      `[worker:chat] Processing job ${job.id ?? 'unknown'} for chatId=${chatJob.chatId}`,
    );
    const record = await recordChatActivity(deps, chatJob);
    const { activity } = record;
    assertActivityIdentity(activity, 'chat', chatJob.id);

    if (record.kind === 'reused') {
      // A source job can be redelivered after its original cleanup delivery has
      // already completed. The cached activity prevents agent re-execution, and
      // this direct confined cleanup prevents the recreated stable spool path
      // from becoming orphaned behind an already-completed delivery ID.
      await removeChatSourceFiles(chatJob);
    } else {
      // ActivityResult is already durable. Telegram preview failure or a crash
      // while draining cannot cause the expensive activity to run again.
      await record.drainPreviews();
    }

    await commitChatSessions(deps.sessionStore, activity.deliveries);
    await deps.deliveryOutbox.enqueue(activity.deliveries);
    return activity.outcome;
  };
}

// ─── Scheduled queue ──────────────────────────────────────────────────────────

async function recordScheduledActivity(
  deps: ScheduledQueueDeps,
  scheduledJob: ScheduledJob,
): Promise<ScheduledRecord> {
  const activityId = makeActivityId('scheduled', scheduledJob.id);
  const existing = await deps.activityResults.find(activityId);
  if (existing !== null) return { kind: 'reused', activity: existing };

  const outcome = await deps.scheduledHandler(scheduledJob);
  // A genuine failure remains retryable (unless the agent policy says otherwise).
  if (outcome.kind === 'failed') {
    if (outcome.cause.kind === 'agent') {
      throwAgentFailure(outcome.cause.failure);
    }
    throw new Error(outcome.cause.message);
  }
  if (outcome.kind === 'skipped') return { kind: 'skipped', outcome };

  const activity = await deps.activityResults.saveIfAbsent({
    schemaVersion: 1,
    id: activityId,
    sourceKind: 'scheduled',
    sourceJobId: scheduledJob.id,
    completedAt: deps.now().toISOString(),
    outcome: {
      kind: 'scheduled-completed',
      response: outcome.response,
      suppressed: outcome.suppressed,
    },
    deliveries: scheduledDeliveries(
      activityId,
      deps.config.authorizedUserIds,
      outcome,
      cortexWorkspace(deps),
    ),
  });
  return { kind: 'recorded', activity };
}

export function processScheduledJob(deps: ScheduledQueueDeps) {
  return async (job: SourceJob): Promise<ActivityResult['outcome'] | SkippedScheduled> => {
    const parsed = parseScheduledJob(job.data);
    if (!parsed.ok) throw new Error(parsed.error);
    const scheduledJob = parsed.value;
    console.info(
      `[worker:scheduled] Processing job ${job.id ?? 'unknown'} skill=${scheduledJob.skillId}`,
    );
    const record = await recordScheduledActivity(deps, scheduledJob);
    if (record.kind === 'skipped') return record.outcome;
    const { activity } = record;
    assertActivityIdentity(activity, 'scheduled', scheduledJob.id);

    // From this point onward retries reuse the immutable result. Redis marker,
    // outbox, or dependent fan-out failures cannot rerun the agent activity.
    await deps.deliveryOutbox.enqueue(activity.deliveries);
    await deps.markScheduledJobCompleted(scheduledJob.id);
    await deps.onScheduledJobCompleted(scheduledJob);
    return activity.outcome;
  };
}
