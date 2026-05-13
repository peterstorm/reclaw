import { match } from 'ts-pattern';
import { makeTelegramUserId, makeChatJob, makeJobId, makePodcastJob, makeReminderJob, makeRecurringReminderJob, makeScheduledJob, makeSkillId, type SkillRegistry } from '../core/types.js';
import { parseRemindCommand, isRemindListCommand, parseRemindCancelCommand, formatReminderList, formatReminderConfirmation } from '../core/reminder.js';
import { parseResearchCommand } from '../core/research-request.js';
import { makeResearchJobData } from '../core/research-types.js';
import { parsePodcastCommand, audioFormatToCode, audioLengthToCode } from '../core/podcast-request.js';
import { parseAskCommand } from '../core/ask-request.js';
import { findNotebookByTopic } from '../infra/research-vault-lookup.js';
import { appendAskAnswer } from '../infra/research-qa-writer.js';
import { resolveAnswerCitations, extractPassageToSourceMap } from '../core/citation-resolver.js';
import { splitMessage } from '../core/message-splitter.js';
import type { SourceMeta } from '../core/research-types.js';
import type { TelegramAdapter } from '../infra/telegram.js';
import type { Queues } from '../infra/queue.js';
import type { SessionStore } from '../infra/session-store.js';
import type { QuotaTracker } from '../infra/quota-tracker.js';
import type { NotebookLMAdapter } from '../infra/notebooklm-client.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type IncomingMessage = {
  readonly userId: number;
  readonly chatId: number;
  readonly text: string;
  readonly replyToMessageId?: number;
  readonly imagePaths?: readonly string[];
};

export type MessageRouterDeps = {
  readonly telegram: TelegramAdapter;
  readonly sessionStore: SessionStore;
  readonly queues: Queues;
  readonly quotaTracker: QuotaTracker;
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
  | { readonly kind: 'help' }
  | { readonly kind: 'chat' };

/** Parse raw message text into a Command for exhaustive routing. */
export function parseCommandKind(text: string): Command {
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
  return { kind: 'chat' };
}

// ─── Router ───────────────────────────────────────────────────────────────────

/**
 * Route an incoming Telegram message to the appropriate handler.
 * Fire-and-forget: catches errors internally and logs them.
 */
export function routeMessage(msg: IncomingMessage, deps: MessageRouterDeps): void {
  const userIdResult = makeTelegramUserId(msg.userId);
  if (!userIdResult.ok) {
    console.error(`[router] Invalid userId from Telegram: ${userIdResult.error}`);
    return;
  }

  match(parseCommandKind(msg.text))
    .with({ kind: 'new' }, () => {
      deps.sessionStore.deleteSession(msg.chatId).then(() => {
        return deps.telegram.sendMessage(msg.chatId, 'Session cleared. Next message starts a fresh conversation.');
      }).catch((err: unknown) => {
        console.error('[router] Failed to handle /new command:', err);
      });
    })
    .with({ kind: 'help' }, () => routeHelpCommand(msg, deps))
    .with({ kind: 'remind' }, () => routeRemindCommand(msg, deps))
    .with({ kind: 'research-status' }, () => routeResearchStatus(msg, deps))
    .with({ kind: 'research' }, () => routeResearchCommand(msg, deps))
    .with({ kind: 'podcast' }, () => routePodcastCommand(msg, deps))
    .with({ kind: 'ask' }, () => routeAskCommand(msg, deps))
    .with({ kind: 'status' }, () => routeStatusCommand(msg, deps))
    .with({ kind: 'run' }, () => routeRunCommand(msg, deps))
    .with({ kind: 'chat' }, () => {
      const replyRouting = msg.replyToMessageId !== undefined
        ? deps.sessionStore.getMessageSession(msg.replyToMessageId).then((sessionId) => {
            if (sessionId === null) return;
            return deps.sessionStore.saveSession(
              msg.chatId,
              { sessionId, lastActivityAt: new Date().toISOString() },
            );
          }).catch((err: unknown) => {
            console.error('[router] Failed to route reply-to session:', err);
          })
        : Promise.resolve();

      replyRouting.then(() => {
        const jobIdRaw = `chat:${msg.userId}:${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
        const jobIdResult = makeJobId(jobIdRaw);
        if (!jobIdResult.ok) {
          console.error(`[router] Failed to create jobId: ${jobIdResult.error}`);
          return;
        }

        const chatJobResult = makeChatJob({
          id: jobIdResult.value,
          userId: userIdResult.value,
          text: msg.text,
          chatId: msg.chatId,
          receivedAt: new Date().toISOString(),
          ...(msg.imagePaths && msg.imagePaths.length > 0 ? { imagePaths: msg.imagePaths } : {}),
        });

        if (!chatJobResult.ok) {
          console.error(`[router] Failed to create ChatJob: ${chatJobResult.error}`);
          return;
        }

        deps.queues.enqueueChat(chatJobResult.value).catch((err: unknown) => {
          console.error('[router] Failed to enqueue chat job:', err);
        });
      }).catch((err: unknown) => {
        console.error('[router] Failed to process message:', err);
      });
    })
    .exhaustive();
}

// ─── /remind sub-router ──────────────────────────────────────────────────────

function routeRemindCommand(msg: IncomingMessage, deps: MessageRouterDeps): void {
  // /remind list
  if (isRemindListCommand(msg.text)) {
    deps.queues.listRecurringReminders()
      .then((reminders) => {
        const mine = reminders.filter((r) => r.chatId === msg.chatId);
        const listMsg = formatReminderList(mine) ?? 'No active recurring reminders.';
        return deps.telegram.sendMessage(msg.chatId, listMsg);
      })
      .catch((listErr: unknown) => {
        console.error('[router] Failed to list recurring reminders:', listErr);
      });
    return;
  }

  // /remind cancel <id>
  const cancelId = parseRemindCancelCommand(msg.text);
  if (cancelId !== null) {
    deps.queues.cancelRecurringReminder(cancelId)
      .then((removed) => {
        const response = removed
          ? `Cancelled recurring reminder: ${cancelId}`
          : `No recurring reminder found with ID: ${cancelId}`;
        return deps.telegram.sendMessage(msg.chatId, response);
      })
      .catch((cancelErr: unknown) => {
        console.error('[router] Failed to cancel recurring reminder:', cancelErr);
      });
    return;
  }

  // Parse the remind command (one-shot or recurring)
  const parseResult = parseRemindCommand(msg.text);
  if (!parseResult.ok) {
    deps.telegram.sendMessage(msg.chatId, parseResult.error).catch((parseErr: unknown) => {
      console.error('[router] Failed to send /remind usage error:', parseErr);
    });
    return;
  }

  // Recurring reminder: /remind every <interval|day> [at <time>] <message>
  if (parseResult.value.kind === 'recurring' || parseResult.value.kind === 'cron-recurring') {
    const recurParsed = parseResult.value;
    const schedulerId = `recur:${msg.userId}:${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const jobIdResult = makeJobId(schedulerId);
    if (!jobIdResult.ok) {
      console.error(`[router] Failed to create recurring reminder jobId: ${jobIdResult.error}`);
      return;
    }

    const recurringResult = makeRecurringReminderJob({
      id: jobIdResult.value,
      chatId: msg.chatId,
      text: recurParsed.text,
      createdAt: new Date().toISOString(),
      ...(recurParsed.kind === 'cron-recurring'
        ? { cronPattern: recurParsed.cronPattern, cronDescription: recurParsed.cronDescription }
        : { intervalMs: recurParsed.intervalMs }),
      schedulerId,
    });

    if (!recurringResult.ok) {
      console.error(`[router] Failed to create RecurringReminderJob: ${recurringResult.error}`);
      return;
    }

    deps.queues.enqueueRecurringReminder(recurringResult.value)
      .then(() => {
        return deps.telegram.sendMessage(msg.chatId, formatReminderConfirmation(parseResult.value));
      })
      .catch((recurErr: unknown) => {
        console.error('[router] Failed to enqueue recurring reminder:', recurErr);
      });
    return;
  }

  // One-shot reminder
  const parsed = parseResult.value;
  const jobIdRaw = `reminder:${msg.userId}:${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const jobIdResult = makeJobId(jobIdRaw);
  if (!jobIdResult.ok) {
    console.error(`[router] Failed to create reminder jobId: ${jobIdResult.error}`);
    return;
  }

  const reminderResult = makeReminderJob({
    id: jobIdResult.value,
    chatId: msg.chatId,
    text: parsed.text,
    createdAt: new Date().toISOString(),
    delayMs: parsed.delayMs,
  });

  if (!reminderResult.ok) {
    console.error(`[router] Failed to create ReminderJob: ${reminderResult.error}`);
    return;
  }

  deps.queues.enqueueReminder(reminderResult.value)
    .then(() => {
      return deps.telegram.sendMessage(msg.chatId, formatReminderConfirmation(parseResult.value));
    })
    .catch((enqErr: unknown) => {
      console.error('[router] Failed to enqueue reminder job:', enqErr);
    });
}

// ─── /research-status ────────────────────────────────────────────────────────

function routeResearchStatus(msg: IncomingMessage, deps: MessageRouterDeps): void {
  deps.queues.getResearchStatus().then(async (status) => {
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
  }).catch((err: unknown) => {
    console.error('[router] Failed to get research status:', err);
  });
}

// ─── /research <topic> ───────────────────────────────────────────────────────

function routeResearchCommand(msg: IncomingMessage, deps: MessageRouterDeps): void {
  // Quota is the first gate: fail fast before parsing or job construction.
  deps.quotaTracker.hasQuota(5).then(async (hasEnoughQuota) => {
    if (!hasEnoughQuota) {
      await deps.telegram.sendMessage(msg.chatId, 'Cannot enqueue research job: daily chat quota too low (need at least 5 remaining).');
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
      sourceHints,
      chatId: msg.chatId,
      generateAudio,
      generateVideo,
    });

    if (!researchJobDataResult.ok) {
      console.error(`[router] Failed to create ResearchJobData: ${researchJobDataResult.error}`);
      deps.telegram.sendMessage(msg.chatId, 'Failed to create research job. Please try again.').catch((e: unknown) => {
        console.error('[router] Failed to send research error:', e);
      });
      return;
    }

    await deps.queues.enqueueResearch(researchJobDataResult.value);

    const position = await deps.queues.getResearchQueuePosition();

    const mediaFlags = [
      generateAudio ? 'audio' : null,
      generateVideo ? 'video' : null,
    ].filter(Boolean);
    const mediaSuffix = mediaFlags.length > 0
      ? `\nMedia: ${mediaFlags.join(' + ')} overview will be generated.`
      : '';

    const promptPreview = prompt.length > 100 ? `${prompt.slice(0, 100)}…` : prompt;
    const confirmMsg = position > 1
      ? `Research enqueued.\nFocus: ${promptPreview}\n\nQueue position: ${position} (${position - 1} job(s) ahead)${mediaSuffix}`
      : `Research enqueued.\nFocus: ${promptPreview}\n\nStarting now. Topic will be derived from your prompt.${mediaSuffix}`;

    await deps.telegram.sendMessage(msg.chatId, confirmMsg);
  }).catch((researchErr: unknown) => {
    console.error('[router] Failed to enqueue research job:', researchErr);
    deps.telegram.sendMessage(msg.chatId, 'An unexpected error occurred while enqueuing your research job. Please try again.').catch((e: unknown) => {
      console.error('[router] Failed to send research error notification:', e);
    });
  });
}

// ─── /help ──────────────────────────────────────────────────────────────────

const HELP_TEXT = [
  'Available commands:',
  '',
  '/help — Show this message',
  '/new — Clear session, start fresh conversation',
  '/status — Queue depths, uptime, redis health',
  '/run <skill-id> — Manually trigger a scheduled skill',
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
  '  Slug = leaf folder under reclaw/research/ (e.g. code-execution-with-mcp).',
  '',
  '/podcast <vault-path> [--format deep-dive|brief|critique|debate] [--length short|default|long]',
  '  Generate audio podcast from a vault note',
  '  Vault path: use Obsidian "Copy vault path" (e.g. reclaw/architecture)',
  '  Defaults: --format deep-dive --length long',
].join('\n');

function routeHelpCommand(msg: IncomingMessage, deps: MessageRouterDeps): void {
  deps.telegram.sendMessage(msg.chatId, HELP_TEXT).catch((err: unknown) => {
    console.error('[router] Failed to send /help response:', err);
  });
}

// ─── /ask <topic-slug> <question> ────────────────────────────────────────────

function routeAskCommand(msg: IncomingMessage, deps: MessageRouterDeps): void {
  void runAsk(msg, deps).catch((err: unknown) => {
    console.error('[router] /ask failed:', err);
    deps.telegram.sendMessage(msg.chatId, 'Failed to run /ask. Try again.').catch(() => {});
  });
}

async function runAsk(msg: IncomingMessage, deps: MessageRouterDeps): Promise<void> {
  if (deps.getNotebookLM === undefined || deps.vaultBasePath === undefined) {
    await deps.telegram.sendMessage(msg.chatId, '/ask is not wired up — NotebookLM adapter or vault path missing.');
    return;
  }

  const parsed = parseAskCommand(msg.text);
  if (!parsed.ok) {
    await deps.telegram.sendMessage(msg.chatId, parsed.error);
    return;
  }

  const lookup = await findNotebookByTopic(deps.vaultBasePath, parsed.value.slug);
  if (!lookup.ok) {
    await deps.telegram.sendMessage(msg.chatId, lookup.error);
    return;
  }

  const hasQuota = await deps.quotaTracker.hasQuota(1);
  if (!hasQuota) {
    await deps.telegram.sendMessage(msg.chatId, 'Daily NotebookLM chat quota exhausted. Try again tomorrow.');
    return;
  }

  const notebookLM = await deps.getNotebookLM();
  if (notebookLM === null) {
    await deps.telegram.sendMessage(msg.chatId, 'NotebookLM is not configured on this reclaw instance.');
    return;
  }

  await deps.telegram.sendMessage(msg.chatId, `Asking notebook: ${lookup.value.topic}…`);

  const chatResult = await notebookLM.chat(lookup.value.notebookId, parsed.value.question);
  if (!chatResult.ok) {
    await deps.telegram.sendMessage(msg.chatId, `NotebookLM error: ${chatResult.error.message}`);
    return;
  }

  const sourcesResult = await notebookLM.listSources(lookup.value.notebookId);
  const sources = sourcesResult.ok ? sourcesResult.value : [];

  const passageMap = extractPassageToSourceMap(chatResult.value.rawData, sources);
  const { resolvedText, citedSourceIndices } = resolveAnswerCitations(
    chatResult.value.text,
    sources,
    passageMap,
  );

  // Persist Q&A to the vault so /ask answers accumulate alongside the
  // canonical research output. Best-effort — never blocks the user reply.
  const citedSources = [...citedSourceIndices]
    .sort((a, b) => a - b)
    .map((i) => sources[i])
    .filter((s): s is SourceMeta => s !== undefined);

  void appendAskAnswer({
    vaultBasePath: deps.vaultBasePath,
    lookup: lookup.value,
    question: parsed.value.question,
    resolvedAnswer: resolvedText,
    citedSources,
  })
    .then((res) => {
      if (!res.ok) console.error(`[router] /ask: failed to persist Q&A: ${res.error}`);
    })
    .catch((e: unknown) => {
      console.error('[router] /ask: persistence threw:', e);
    });

  const reply = formatAskReply(resolvedText, sources, citedSourceIndices, lookup.value);
  const chunks = splitMessage(reply);
  await deps.telegram.sendChunkedMessage(msg.chatId, chunks);
}

function formatAskReply(
  resolvedText: string,
  sources: ReadonlyArray<{ readonly title: string; readonly url: string }>,
  citedSourceIndices: ReadonlySet<number>,
  lookup: { readonly topic: string; readonly hubVaultPath: string },
): string {
  const cited = [...citedSourceIndices]
    .sort((a, b) => a - b)
    .map((i) => sources[i])
    .filter((s): s is { readonly title: string; readonly url: string } => s !== undefined);

  const sourcesSection = cited.length > 0
    ? '\n\nSources:\n' + cited.map((s) => `• ${s.title}\n  ${s.url}`).join('\n')
    : '';

  // Hub link is rendered as the vault path so the user can open it in Obsidian.
  const hubLink = `\n\n→ ${lookup.hubVaultPath.replace(/\.md$/, '')}`;

  return `${resolvedText}${sourcesSection}${hubLink}`;
}

// ─── /podcast <vault-path> ──────────────────────────────────────────────────

function routePodcastCommand(msg: IncomingMessage, deps: MessageRouterDeps): void {
  const parseResult = parsePodcastCommand(msg.text);

  if (!parseResult.ok) {
    deps.telegram.sendMessage(msg.chatId, parseResult.error).catch((parseErr: unknown) => {
      console.error('[router] Failed to send /podcast parse error:', parseErr);
    });
    return;
  }

  const { notePath, format, length } = parseResult.value;
  const jobIdRaw = `podcast:${msg.userId}:${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const jobIdResult = makeJobId(jobIdRaw);
  if (!jobIdResult.ok) {
    console.error(`[router] Failed to create podcast jobId: ${jobIdResult.error}`);
    return;
  }

  const podcastJobResult = makePodcastJob({
    id: jobIdResult.value,
    chatId: msg.chatId,
    notePath,
    audioFormat: audioFormatToCode(format),
    audioLength: audioLengthToCode(length),
    enqueuedAt: new Date().toISOString(),
  });

  if (!podcastJobResult.ok) {
    console.error(`[router] Failed to create PodcastJob: ${podcastJobResult.error}`);
    deps.telegram.sendMessage(msg.chatId, 'Failed to create podcast job. Please try again.').catch((e: unknown) => {
      console.error('[router] Failed to send podcast error:', e);
    });
    return;
  }

  deps.queues.enqueuePodcast(podcastJobResult.value)
    .then(async () => {
      const formatLabel = format === 'deep-dive' ? 'Deep Dive' : format.charAt(0).toUpperCase() + format.slice(1);
      await deps.telegram.sendMessage(
        msg.chatId,
        `Podcast enqueued: "${notePath}"\nFormat: ${formatLabel}\n\nStarting now. This may take up to 15 minutes.`,
      );
    })
    .catch((enqErr: unknown) => {
      console.error('[router] Failed to enqueue podcast job:', enqErr);
      deps.telegram.sendMessage(msg.chatId, 'Failed to enqueue podcast job. Please try again.').catch((e: unknown) => {
        console.error('[router] Failed to send podcast error notification:', e);
      });
    });
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

function routeStatusCommand(msg: IncomingMessage, deps: MessageRouterDeps): void {
  (async () => {
    const [chatCounts, scheduledCounts, reminderCounts, researchCounts, podcastCounts] = await Promise.all([
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
      await client.ping();
      redisStatus = `${Date.now() - pingStart}ms`;
    } catch (err) {
      console.error('[router] /status: redis ping failed:', err);
    }

    const skillCount = deps.getSkillRegistry !== undefined
      ? deps.getSkillRegistry().size
      : null;

    const fmtCounts = (c: { wait?: number; active?: number; failed?: number; delayed?: number }): string =>
      `${c.wait ?? 0}/${c.active ?? 0}/${c.failed ?? 0}/${c.delayed ?? 0}`;

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
  })().catch((err: unknown) => {
    console.error('[router] /status failed:', err);
    deps.telegram.sendMessage(msg.chatId, 'Failed to retrieve status.').catch(() => {});
  });
}

// ─── /run <skill-id> — manual skill trigger ──────────────────────────────────

function routeRunCommand(msg: IncomingMessage, deps: MessageRouterDeps): void {
  if (deps.getSkillRegistry === undefined) {
    deps.telegram.sendMessage(msg.chatId, 'Skill registry not available — /run is disabled.').catch(() => {});
    return;
  }

  const parts = msg.text.trim().split(/\s+/);
  const rawSkillId = parts[1];
  if (!rawSkillId || rawSkillId === '') {
    deps.telegram.sendMessage(msg.chatId, 'Usage: /run <skill-id>\nUse /status to see how many skills are loaded; check workspace/skills/ for IDs.').catch(() => {});
    return;
  }

  const skillIdResult = makeSkillId(rawSkillId);
  if (!skillIdResult.ok) {
    deps.telegram.sendMessage(msg.chatId, `Invalid skill id "${rawSkillId}": ${skillIdResult.error}`).catch(() => {});
    return;
  }

  const registry = deps.getSkillRegistry();
  const skill = registry.get(skillIdResult.value);
  if (skill === undefined) {
    const known = [...registry.keys()].slice(0, 20).join(', ');
    deps.telegram.sendMessage(msg.chatId, `Unknown skill "${rawSkillId}". Known: ${known}`).catch(() => {});
    return;
  }

  const triggeredAt = new Date();
  triggeredAt.setMilliseconds(0);
  const triggeredIso = triggeredAt.toISOString();
  const validUntilIso = new Date(triggeredAt.getTime() + skill.validityWindowMinutes * 60 * 1000).toISOString();

  // Distinct ID prefix so a manual trigger never collides with the cron-fired
  // job ID for the same skill at the same minute.
  const sanitized = triggeredIso.replaceAll(':', '-');
  const jobIdRaw = `scheduled:${skill.id}:run:${sanitized}-${crypto.randomUUID().slice(0, 8)}`;
  const jobIdResult = makeJobId(jobIdRaw);
  if (!jobIdResult.ok) {
    console.error(`[router] /run: failed to make jobId: ${jobIdResult.error}`);
    deps.telegram.sendMessage(msg.chatId, 'Failed to create job.').catch(() => {});
    return;
  }

  const scheduledJobResult = makeScheduledJob({
    id: jobIdResult.value,
    skillId: skill.id,
    triggeredAt: triggeredIso,
    validUntil: validUntilIso,
  });

  if (!scheduledJobResult.ok) {
    console.error(`[router] /run: failed to build ScheduledJob: ${scheduledJobResult.error}`);
    deps.telegram.sendMessage(msg.chatId, 'Failed to build scheduled job.').catch(() => {});
    return;
  }

  deps.queues.enqueueScheduled(scheduledJobResult.value)
    .then(() => deps.telegram.sendMessage(msg.chatId, `Triggered "${skill.id}" — output will arrive in chat when it completes.`))
    .catch((err: unknown) => {
      console.error('[router] /run: enqueue failed:', err);
      deps.telegram.sendMessage(msg.chatId, 'Failed to enqueue manual run.').catch(() => {});
    });
}
