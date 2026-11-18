import { match } from 'ts-pattern';
import { parseAskCommand } from '../core/ask-request.js';
import {
  citedSourceIndicesOf,
  extractPassageToSourceMap,
  resolveAnswerCitations,
} from '../core/citation-resolver.js';
import { parseDlqCommand } from '../core/dead-letter.js';
import { splitMessage } from '../core/message-splitter.js';
import {
  audioFormatToCode,
  audioLengthToCode,
  parsePodcastCommand,
} from '../core/podcast-request.js';
import {
  type ParsedReminder,
  formatReminderConfirmation,
  formatReminderList,
  isRemindListCommand,
  parseRemindCancelCommand,
  parseRemindCommand,
} from '../core/reminder.js';
import { parseResearchCommand } from '../core/research-request.js';
import { makeResearchJobData } from '../core/research-types.js';
import type { SourceMeta } from '../core/research-types.js';
import {
  type AgentBackendName,
  type JobId,
  type Result,
  type SkillConfig,
  type SkillRegistry,
  type TelegramIngressKind,
  err,
  makeChatJob,
  makePodcastJob,
  makeRecurringReminderJob,
  makeReminderJob,
  makeScheduledJob,
  makeSkillId,
  makeTelegramIngressJobId,
  makeTelegramUserId,
  ok,
} from '../core/types.js';
import type { NotebookLMAdapter } from '../infra/notebooklm-client.js';
import type { Queues } from '../infra/queue.js';
import type { QuotaTracker } from '../infra/quota-tracker.js';
import { appendAskAnswer } from '../infra/research-qa-writer.js';
import { type NotebookLookup, findNotebookByTopic } from '../infra/research-vault-lookup.js';
import type { SessionStore } from '../infra/session-store.js';
import type {
  TelegramAdapter,
  TelegramIncomingDisposition,
  TelegramIncomingMessage,
} from '../infra/telegram.js';
import { runDlqCommand } from './dlq-command.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type IncomingMessage = TelegramIncomingMessage;

export type MessageRouterDeps = {
  readonly telegram: TelegramAdapter;
  readonly sessionStore: SessionStore;
  readonly queues: Queues;
  readonly quotaTracker: QuotaTracker;
  readonly agentBackend: AgentBackendName;
  /** Resolved fresh on each call so hot-reloaded skills are visible. */
  readonly getSkillRegistry?: () => SkillRegistry;
  /** Lazy-init NotebookLM adapter for /ask. Returns null if creds missing. */
  readonly getNotebookLM?: () => Promise<NotebookLMAdapter | null>;
  /** Vault root path used by /ask to locate hub notes. */
  readonly vaultBasePath?: string;
};

// ─── Command Discriminated Union ─────────────────────────────────────────────

type Command =
  | { readonly kind: 'new' }
  | { readonly kind: 'remind' }
  | { readonly kind: 'research-status' }
  | { readonly kind: 'research' }
  | { readonly kind: 'podcast' }
  | { readonly kind: 'ask' }
  | { readonly kind: 'status' }
  | { readonly kind: 'run' }
  | { readonly kind: 'dlq' }
  | { readonly kind: 'help' }
  | { readonly kind: 'chat' };

/** Parse raw message text into a Command for exhaustive routing. */
function parseCommandKind(text: string): Command {
  const trimmed = text.trim();
  if (trimmed === '/new') return { kind: 'new' };
  if (trimmed.startsWith('/remind')) return { kind: 'remind' };
  const lower = trimmed.toLowerCase();
  if (lower === '/help') return { kind: 'help' };
  if (lower === '/status') return { kind: 'status' };
  if (lower === '/research-status') return { kind: 'research-status' };
  if (lower.startsWith('/research')) return { kind: 'research' };
  if (lower.startsWith('/podcast')) return { kind: 'podcast' };
  if (lower.startsWith('/ask')) return { kind: 'ask' };
  if (lower.startsWith('/run')) return { kind: 'run' };
  if (lower === '/dlq' || lower.startsWith('/dlq ')) return { kind: 'dlq' };
  return { kind: 'chat' };
}

// ─── Router ───────────────────────────────────────────────────────────────────

/** Resolve the stable BullMQ identity owned by one Telegram update. */
function ingressJobId(msg: IncomingMessage, kind: TelegramIngressKind): JobId {
  const result = makeTelegramIngressJobId(msg.updateId, kind);
  if (!result.ok) throw new Error(`Failed to construct Telegram ingress job ID: ${result.error}`);
  return result.value;
}

async function complete(effect: Promise<void>): Promise<undefined> {
  await effect;
  return undefined;
}

/**
 * Route one authenticated Telegram update. The returned promise is the ingress
 * acknowledgement boundary: callers must not advance the update offset until
 * it resolves.
 */
export async function routeMessage(
  msg: IncomingMessage,
  deps: MessageRouterDeps,
): Promise<TelegramIncomingDisposition | undefined> {
  const userIdResult = makeTelegramUserId(msg.userId);
  if (!userIdResult.ok) {
    console.error(`[router] Invalid userId from Telegram: ${userIdResult.error}`);
    return;
  }

  const hasAttachments =
    (msg.imagePaths !== undefined && msg.imagePaths.length > 0) ||
    (msg.documentPaths !== undefined && msg.documentPaths.length > 0) ||
    (msg.storedUploads !== undefined && msg.storedUploads.length > 0);
  const command = hasAttachments ? ({ kind: 'chat' } as const) : parseCommandKind(msg.text);

  return match(command)
    .with({ kind: 'new' }, async () => {
      const now = new Date().toISOString();
      await deps.sessionStore.advance(
        msg.chatId,
        ingressJobId(msg, 'chat'),
        { kind: 'fresh', backend: deps.agentBackend },
        now,
      );
      await deps.telegram.sendMessage(
        msg.chatId,
        'Conversation reset. Next message starts a fresh generation.',
      );
      return undefined;
    })
    .with({ kind: 'help' }, () => complete(routeHelpCommand(msg, deps)))
    .with({ kind: 'remind' }, () => complete(routeRemindCommand(msg, deps)))
    .with({ kind: 'research-status' }, () => complete(routeResearchStatus(msg, deps)))
    .with({ kind: 'research' }, () => complete(routeResearchCommand(msg, deps)))
    .with({ kind: 'podcast' }, () => complete(routePodcastCommand(msg, deps)))
    .with({ kind: 'ask' }, () => complete(runAsk(msg, deps)))
    .with({ kind: 'status' }, () => complete(routeStatusCommand(msg, deps)))
    .with({ kind: 'run' }, () => complete(routeRunCommand(msg, deps)))
    .with({ kind: 'dlq' }, () => complete(routeDlqCommand(msg, deps)))
    .with({ kind: 'chat' }, async () => {
      const jobId = ingressJobId(msg, 'chat');
      const now = new Date().toISOString();
      const replyReference =
        msg.replyContext === undefined
          ? null
          : await deps.sessionStore.getMessageReference(msg.chatId, msg.replyContext.messageId);
      const lineage =
        replyReference === null
          ? await deps.sessionStore.getCurrent(msg.chatId)
          : await deps.sessionStore.advance(
              msg.chatId,
              jobId,
              {
                kind: 'resume',
                backend: replyReference.backend,
                sessionId: replyReference.sessionId,
              },
              now,
            );

      const chatJobResult = makeChatJob({
        id: jobId,
        userId: userIdResult.value,
        text: msg.text,
        chatId: msg.chatId,
        receivedAt: now,
        conversation: {
          generation: lineage.generation,
          revision: lineage.revision,
          backend: lineage.backend,
          sessionId: lineage.sessionId,
        },
        ...(msg.replyContext !== undefined ? { replyContext: msg.replyContext } : {}),
        ...(msg.imagePaths && msg.imagePaths.length > 0 ? { imagePaths: msg.imagePaths } : {}),
        ...(msg.documentPaths && msg.documentPaths.length > 0
          ? { documentPaths: msg.documentPaths }
          : {}),
        ...(msg.storedUploads && msg.storedUploads.length > 0
          ? { storedUploads: msg.storedUploads }
          : {}),
      });

      if (!chatJobResult.ok) {
        await deps.telegram.sendMessage(
          msg.chatId,
          `Cannot accept message: ${chatJobResult.error}`,
        );
        return undefined;
      }

      const disposition = await deps.queues.enqueueChat(chatJobResult.value);
      return disposition === 'terminal-duplicate'
        ? ({ kind: 'remove-source-files' } as const)
        : ({ kind: 'retain-source-files' } as const);
    })
    .exhaustive();
}

// ─── /remind sub-router ──────────────────────────────────────────────────────

async function routeRemindCommand(msg: IncomingMessage, deps: MessageRouterDeps): Promise<void> {
  if (isRemindListCommand(msg.text)) {
    const reminders = await deps.queues.listRecurringReminders();
    const mine = reminders.filter((r) => r.chatId === msg.chatId);
    await deps.telegram.sendMessage(
      msg.chatId,
      formatReminderList(mine) ?? 'No active recurring reminders.',
    );
    return;
  }

  const cancelId = parseRemindCancelCommand(msg.text);
  if (cancelId !== null) {
    const removed = await deps.queues.cancelRecurringReminder(cancelId);
    const response = removed
      ? `Cancelled recurring reminder: ${cancelId}`
      : `No recurring reminder found with ID: ${cancelId}`;
    await deps.telegram.sendMessage(msg.chatId, response);
    return;
  }

  // One clock reading for the parse and the confirmation, so "at 14:30" and the
  // echoed time can never straddle a minute boundary.
  const now = new Date();
  const parseResult = parseRemindCommand(msg.text, now);
  if (!parseResult.ok) {
    await deps.telegram.sendMessage(msg.chatId, parseResult.error);
    return;
  }

  const reminder = parseResult.value;
  const enqueued =
    reminder.kind === 'recurring' || reminder.kind === 'cron-recurring'
      ? await enqueueRecurringReminder(msg, deps, reminder)
      : await enqueueOneShotReminder(msg, deps, reminder);
  await deps.telegram.sendMessage(
    msg.chatId,
    enqueued.ok ? formatReminderConfirmation(reminder, now) : enqueued.error,
  );
}

type RecurringReminder = Extract<ParsedReminder, { kind: 'recurring' | 'cron-recurring' }>;
type OneShotReminder = Exclude<ParsedReminder, RecurringReminder>;

/** Enqueue a recurring reminder; err carries the message to send instead of a confirmation. */
async function enqueueRecurringReminder(
  msg: IncomingMessage,
  deps: MessageRouterDeps,
  reminder: RecurringReminder,
): Promise<Result<undefined, string>> {
  const jobId = ingressJobId(msg, 'recurring');
  const recurringResult = makeRecurringReminderJob({
    id: jobId,
    chatId: msg.chatId,
    text: reminder.text,
    createdAt: new Date().toISOString(),
    ...(reminder.kind === 'cron-recurring'
      ? { cronPattern: reminder.cronPattern, cronDescription: reminder.cronDescription }
      : { intervalMs: reminder.intervalMs }),
    schedulerId: jobId,
  });
  if (!recurringResult.ok) {
    return err(`Cannot create recurring reminder: ${recurringResult.error}`);
  }
  await deps.queues.enqueueRecurringReminder(recurringResult.value);
  return ok(undefined);
}

/** Enqueue a one-shot reminder; err carries the message to send instead of a confirmation. */
async function enqueueOneShotReminder(
  msg: IncomingMessage,
  deps: MessageRouterDeps,
  reminder: OneShotReminder,
): Promise<Result<undefined, string>> {
  const reminderResult = makeReminderJob({
    id: ingressJobId(msg, 'reminder'),
    chatId: msg.chatId,
    text: reminder.text,
    createdAt: new Date().toISOString(),
    delayMs: reminder.delayMs,
  });
  if (!reminderResult.ok) {
    return err(`Cannot create reminder: ${reminderResult.error}`);
  }
  await deps.queues.enqueueReminder(reminderResult.value);
  return ok(undefined);
}

// ─── /research-status ────────────────────────────────────────────────────────

async function routeResearchStatus(msg: IncomingMessage, deps: MessageRouterDeps): Promise<void> {
  const status = await deps.queues.getResearchStatus();
  if (!status.active && status.waiting === 0) {
    await deps.telegram.sendMessage(msg.chatId, 'No research jobs running or queued.');
    return;
  }
  const lines: string[] = [];
  if (status.active) {
    lines.push(
      `Research: "${status.active.topic}"`,
      `State: ${status.active.state}`,
      `Progress: ${status.active.progress}%`,
      `Started: ${status.active.startedAt}`,
    );
  }
  if (status.waiting > 0) {
    lines.push(`\nQueued: ${status.waiting} job(s) waiting`);
  }
  await deps.telegram.sendMessage(msg.chatId, lines.join('\n'));
}

// ─── /research <topic> ───────────────────────────────────────────────────────

async function routeResearchCommand(msg: IncomingMessage, deps: MessageRouterDeps): Promise<void> {
  const hasEnoughQuota = await deps.quotaTracker.hasQuota(5);
  if (!hasEnoughQuota) {
    await deps.telegram.sendMessage(
      msg.chatId,
      'Cannot enqueue research job: daily chat quota too low (need at least 5 remaining).',
    );
    return;
  }

  const researchParseResult = parseResearchCommand(msg.text);
  if (!researchParseResult.ok) {
    await deps.telegram.sendMessage(msg.chatId, researchParseResult.error);
    return;
  }

  const { prompt, sourceHints, generateAudio, generateVideo } = researchParseResult.value;
  const researchJobDataResult = makeResearchJobData({
    prompt,
    now: new Date(),
    sourceHints,
    chatId: msg.chatId,
    generateAudio,
    generateVideo,
  });

  if (!researchJobDataResult.ok) {
    await deps.telegram.sendMessage(
      msg.chatId,
      `Cannot create research job: ${researchJobDataResult.error}`,
    );
    return;
  }

  await deps.queues.enqueueResearch(ingressJobId(msg, 'research'), researchJobDataResult.value);
  const position = await deps.queues.getResearchQueuePosition();

  const mediaFlags = [generateAudio ? 'audio' : null, generateVideo ? 'video' : null].filter(
    Boolean,
  );
  const mediaSuffix =
    mediaFlags.length > 0 ? `\nMedia: ${mediaFlags.join(' + ')} overview will be generated.` : '';

  const promptPreview = prompt.length > 100 ? `${prompt.slice(0, 100)}…` : prompt;
  const confirmMsg =
    position > 1
      ? `Research enqueued.\nFocus: ${promptPreview}\n\nQueue position: ${position} (${position - 1} job(s) ahead)${mediaSuffix}`
      : `Research enqueued.\nFocus: ${promptPreview}\n\nStarting now. Topic will be derived from your prompt.${mediaSuffix}`;

  await deps.telegram.sendMessage(msg.chatId, confirmMsg);
}

// ─── /help ──────────────────────────────────────────────────────────────────

const HELP_TEXT = [
  'Available commands:',
  '',
  '/help — Show this message',
  '/new — Clear session, start fresh conversation',
  '/status — Queue depths, uptime, redis health',
  '/run <skill-id> — Manually trigger a scheduled skill',
  '/dlq — Failed scheduled jobs by skill, fresh vs stale',
  '/dlq retry — Retry fresh failed jobs',
  '/dlq clear — Remove stale/unreadable failed jobs',
  '',
  '/remind <duration|time> <message> — Set a one-shot reminder',
  '/remind every <interval|day> [at <time>] <message> — Recurring reminder',
  '/remind list — List active recurring reminders',
  '/remind cancel <id> — Cancel a recurring reminder',
  '',
  '/research <prompt> [--audio] [--video] [--link <url>]',
  '  Deep research with NotebookLM + Claude. Topic is derived automatically.',
  '/research-status — Check research job progress',
  '',
  '/ask <topic-slug> <question>',
  '  One-shot question against an existing research notebook.',
  '  Slug = leaf folder under research/runs/ (e.g. code-execution-with-mcp).',
  '',
  '/podcast <vault-path> [--format deep-dive|brief|critique|debate] [--length short|default|long]',
  '  Generate audio podcast from a vault note',
  '  Vault path: use Obsidian "Copy vault path" (e.g. reclaw/core/architecture)',
  '  Defaults: --format deep-dive --length long',
].join('\n');

async function routeHelpCommand(msg: IncomingMessage, deps: MessageRouterDeps): Promise<void> {
  await deps.telegram.sendMessage(msg.chatId, HELP_TEXT);
}

// ─── /ask <topic-slug> <question> ────────────────────────────────────────────

async function runAsk(msg: IncomingMessage, deps: MessageRouterDeps): Promise<void> {
  const target = await resolveAskTarget(msg, deps);
  if (!target.ok) {
    await deps.telegram.sendMessage(msg.chatId, target.error);
    return;
  }
  const { notebookLM, lookup, question, vaultBasePath } = target.value;

  await deps.telegram.sendMessage(msg.chatId, `Asking notebook: ${lookup.topic}…`);

  const chatResult = await notebookLM.chat(lookup.notebookId, question);
  if (!chatResult.ok) {
    await deps.telegram.sendMessage(msg.chatId, `NotebookLM error: ${chatResult.error.message}`);
    return;
  }

  const sourcesResult = await notebookLM.listSources(lookup.notebookId);
  if (!sourcesResult.ok) {
    await deps.telegram.sendMessage(
      msg.chatId,
      `NotebookLM answered, but source lookup failed; citations are unavailable: ${sourcesResult.error.message}`,
    );
  }
  const sources = sourcesResult.ok ? sourcesResult.value : [];

  const passageMap = extractPassageToSourceMap(chatResult.value.rawData, sources);
  const resolution = resolveAnswerCitations(chatResult.value.text, sources, passageMap);
  const { resolvedText } = resolution;
  const citedSources = citedInOrder(sources, citedSourceIndicesOf(resolution));

  // Complete the best-effort Q&A write before acknowledging the update. A
  // vault failure does not suppress an otherwise valid answer, but it is no
  // longer detached from ingress lifecycle and process shutdown.
  const persisted = await appendAskAnswer({
    vaultBasePath,
    lookup,
    question,
    resolvedAnswer: resolvedText,
    citedSources,
  });
  if (!persisted.ok) console.error(`[router] /ask: failed to persist Q&A: ${persisted.error}`);

  const reply = formatAskReply(resolvedText, citedSources, lookup);
  await deps.telegram.sendChunkedMessage(msg.chatId, splitMessage(reply));
}

type AskTarget = {
  readonly notebookLM: NotebookLMAdapter;
  readonly lookup: NotebookLookup;
  readonly question: string;
  readonly vaultBasePath: string;
};

/**
 * Everything /ask needs before it spends a NotebookLM chat: wiring, a parsed
 * command, the topic's notebook, quota, and an adapter. err carries the reply.
 */
async function resolveAskTarget(
  msg: IncomingMessage,
  deps: MessageRouterDeps,
): Promise<Result<AskTarget, string>> {
  if (deps.getNotebookLM === undefined || deps.vaultBasePath === undefined) {
    return err('/ask is not wired up — NotebookLM adapter or vault path missing.');
  }
  const parsed = parseAskCommand(msg.text);
  if (!parsed.ok) return err(parsed.error);

  const lookup = await findNotebookByTopic(deps.vaultBasePath, parsed.value.slug);
  if (!lookup.ok) return err(lookup.error);

  const hasQuota = await deps.quotaTracker.hasQuota(1);
  if (!hasQuota) return err('Daily NotebookLM chat quota exhausted. Try again tomorrow.');

  const notebookLM = await deps.getNotebookLM();
  if (notebookLM === null) return err('NotebookLM is not configured on this reclaw instance.');

  return ok({
    notebookLM,
    lookup: lookup.value,
    question: parsed.value.question,
    vaultBasePath: deps.vaultBasePath,
  });
}

/** The cited sources in source-index order; indices with no source are dropped. */
const citedInOrder = (
  sources: readonly SourceMeta[],
  citedSourceIndices: ReadonlySet<number>,
): readonly SourceMeta[] =>
  [...citedSourceIndices]
    .sort((a, b) => a - b)
    .map((i) => sources[i])
    .filter((s): s is SourceMeta => s !== undefined);

function formatAskReply(
  resolvedText: string,
  cited: ReadonlyArray<{ readonly title: string; readonly url: string }>,
  lookup: { readonly topic: string; readonly hubVaultPath: string },
): string {
  const sourcesSection =
    cited.length > 0
      ? `\n\nSources:\n${cited.map((s) => `• ${s.title}\n  ${s.url}`).join('\n')}`
      : '';

  // Hub link is rendered as the vault path so the user can open it in Obsidian.
  const hubLink = `\n\n→ ${lookup.hubVaultPath.replace(/\.md$/, '')}`;

  return `${resolvedText}${sourcesSection}${hubLink}`;
}

// ─── /podcast <vault-path> ──────────────────────────────────────────────────

async function routePodcastCommand(msg: IncomingMessage, deps: MessageRouterDeps): Promise<void> {
  const parseResult = parsePodcastCommand(msg.text);

  if (!parseResult.ok) {
    await deps.telegram.sendMessage(msg.chatId, parseResult.error);
    return;
  }

  const { notePath, format, length } = parseResult.value;
  const podcastJobResult = makePodcastJob({
    id: ingressJobId(msg, 'podcast'),
    chatId: msg.chatId,
    notePath,
    audioFormat: audioFormatToCode(format),
    audioLength: audioLengthToCode(length),
    enqueuedAt: new Date().toISOString(),
  });

  if (!podcastJobResult.ok) {
    await deps.telegram.sendMessage(
      msg.chatId,
      `Cannot create podcast job: ${podcastJobResult.error}`,
    );
    return;
  }

  await deps.queues.enqueuePodcast(podcastJobResult.value);
  const formatLabel =
    format === 'deep-dive' ? 'Deep Dive' : format.charAt(0).toUpperCase() + format.slice(1);
  await deps.telegram.sendMessage(
    msg.chatId,
    `Podcast enqueued: "${notePath}"\nFormat: ${formatLabel}\n\nStarting now. This may take up to 15 minutes.`,
  );
}

// ─── /status — operator visibility ───────────────────────────────────────────

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

async function routeStatusCommand(msg: IncomingMessage, deps: MessageRouterDeps): Promise<void> {
  const [chatCounts, scheduledCounts, reminderCounts, researchCounts, podcastCounts] =
    await Promise.all([
      deps.queues.chat.getJobCounts('wait', 'active', 'failed', 'delayed'),
      deps.queues.scheduled.getJobCounts('wait', 'active', 'failed', 'delayed'),
      deps.queues.reminder.getJobCounts('wait', 'active', 'failed', 'delayed'),
      deps.queues.research.getJobCounts('wait', 'active', 'failed', 'delayed'),
      deps.queues.podcast.getJobCounts('wait', 'active', 'failed', 'delayed'),
    ]);

  let redisStatus = 'unreachable';
  try {
    const client = await deps.queues.chat.client;
    const pingStart = Date.now();
    await client.get('reclaw:healthcheck');
    redisStatus = `${Date.now() - pingStart}ms`;
  } catch (err) {
    console.error('[router] /status: redis ping failed:', err);
  }

  const skillCount = deps.getSkillRegistry !== undefined ? deps.getSkillRegistry().size : null;

  const fmtCounts = (c: {
    wait?: number;
    active?: number;
    failed?: number;
    delayed?: number;
  }): string => `${c.wait ?? 0}/${c.active ?? 0}/${c.failed ?? 0}/${c.delayed ?? 0}`;

  const lines = [
    'Reclaw status',
    `Uptime: ${formatUptime(Math.floor(process.uptime()))}`,
    `Redis: ${redisStatus}`,
    ...(skillCount !== null ? [`Skills loaded: ${skillCount}`] : []),
    '',
    'Queues (waiting/active/failed/delayed)',
    `chat       ${fmtCounts(chatCounts)}`,
    `scheduled  ${fmtCounts(scheduledCounts)}`,
    `reminder   ${fmtCounts(reminderCounts)}`,
    `research   ${fmtCounts(researchCounts)}`,
    `podcast    ${fmtCounts(podcastCounts)}`,
  ];

  await deps.telegram.sendMessage(msg.chatId, lines.join('\n'));
}

// ─── /dlq [retry|clear] — dead-letter triage ─────────────────────────────────

async function routeDlqCommand(msg: IncomingMessage, deps: MessageRouterDeps): Promise<void> {
  const parsed = parseDlqCommand(msg.text);
  const reply = parsed.ok
    ? await runDlqCommand(parsed.value, { store: deps.queues.deadLetters, now: () => new Date() })
    : parsed.error;
  await deps.telegram.sendMessage(msg.chatId, reply);
}

// ─── /run <skill-id> — manual skill trigger ──────────────────────────────────

async function routeRunCommand(msg: IncomingMessage, deps: MessageRouterDeps): Promise<void> {
  const skill = resolveRunSkill(msg.text, deps.getSkillRegistry);
  if (!skill.ok) {
    await deps.telegram.sendMessage(msg.chatId, skill.error);
    return;
  }

  const runWindow = manualRunWindow(new Date(), skill.value.validityWindowMinutes);
  const scheduledJobResult = makeScheduledJob({
    id: ingressJobId(msg, 'run'),
    skillId: skill.value.id,
    triggeredAt: runWindow.triggeredAt,
    validUntil: runWindow.validUntil,
    trigger: 'manual',
  });

  if (!scheduledJobResult.ok) {
    await deps.telegram.sendMessage(
      msg.chatId,
      `Cannot create manual run: ${scheduledJobResult.error}`,
    );
    return;
  }

  await deps.queues.enqueueScheduled(scheduledJobResult.value);
  await deps.telegram.sendMessage(
    msg.chatId,
    `Triggered "${skill.value.id}" — output will arrive in chat when it completes.`,
  );
}

/** Resolve the skill a /run command names; err carries the reply. */
function resolveRunSkill(
  text: string,
  getSkillRegistry: (() => SkillRegistry) | undefined,
): Result<SkillConfig, string> {
  if (getSkillRegistry === undefined) {
    return err('Skill registry not available — /run is disabled.');
  }
  const rawSkillId = text.trim().split(/\s+/)[1];
  if (!rawSkillId || rawSkillId === '') {
    return err(
      'Usage: /run <skill-id>\nUse /status to see how many skills are loaded; check workspace/skills/ for IDs.',
    );
  }
  const skillIdResult = makeSkillId(rawSkillId);
  if (!skillIdResult.ok) return err(`Invalid skill id "${rawSkillId}": ${skillIdResult.error}`);

  const registry = getSkillRegistry();
  const skill = registry.get(skillIdResult.value);
  if (skill === undefined) {
    const known = [...registry.keys()].slice(0, 20).join(', ');
    return err(`Unknown skill "${rawSkillId}". Known: ${known}`);
  }
  return ok(skill);
}

/** A manual run triggers at `now` (whole seconds) and stays valid for the skill's window. */
function manualRunWindow(
  now: Date,
  validityWindowMinutes: number,
): { readonly triggeredAt: string; readonly validUntil: string } {
  const triggeredAt = new Date(now);
  triggeredAt.setMilliseconds(0);
  return {
    triggeredAt: triggeredAt.toISOString(),
    validUntil: new Date(triggeredAt.getTime() + validityWindowMinutes * 60 * 1000).toISOString(),
  };
}
