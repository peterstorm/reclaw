import { match } from 'ts-pattern';
import { makeTelegramUserId, makeChatJob, makeJobId, makePodcastJob, makeReminderJob, makeRecurringReminderJob } from '../core/types.js';
import { parseRemindCommand, isRemindListCommand, parseRemindCancelCommand, formatReminderList, formatReminderConfirmation } from '../core/reminder.js';
import { parseResearchCommand } from '../core/research-request.js';
import { makeResearchJobData } from '../core/research-types.js';
import { parsePodcastCommand, audioFormatToCode, audioLengthToCode } from '../core/podcast-request.js';
import type { TelegramAdapter } from '../infra/telegram.js';
import type { Queues } from '../infra/queue.js';
import type { SessionStore } from '../infra/session-store.js';
import type { QuotaTracker } from '../infra/quota-tracker.js';

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
};

// ─── Command Discriminated Union ─────────────────────────────────────────────

type Command =
  | { readonly kind: 'new' }
  | { readonly kind: 'remind' }
  | { readonly kind: 'research-status' }
  | { readonly kind: 'research' }
  | { readonly kind: 'podcast' }
  | { readonly kind: 'help' }
  | { readonly kind: 'chat' };

/** Parse raw message text into a Command for exhaustive routing. */
export function parseCommandKind(text: string): Command {
  const trimmed = text.trim();
  if (trimmed === '/new') return { kind: 'new' };
  if (trimmed.startsWith('/remind')) return { kind: 'remind' };
  const lower = trimmed.toLowerCase();
  if (lower === '/help') return { kind: 'help' };
  if (lower === '/research-status') return { kind: 'research-status' };
  if (lower.startsWith('/research')) return { kind: 'research' };
  if (lower.startsWith('/podcast')) return { kind: 'podcast' };
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

    const { topic, prompt, sourceHints, generateAudio, generateVideo } = researchParseResult.value;

    const researchJobDataResult = makeResearchJobData({
      topic,
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

    const promptSuffix = prompt ? `\nFocus: ${prompt}` : '';
    const confirmMsg = position > 1
      ? `Research enqueued: "${topic}"${promptSuffix}\n\nQueue position: ${position} (${position - 1} job(s) ahead)${mediaSuffix}`
      : `Research enqueued: "${topic}"${promptSuffix}\n\nStarting now.${mediaSuffix}`;

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
  '',
  '/remind <duration|time> <message> — Set a one-shot reminder',
  '/remind every <interval|day> [at <time>] <message> — Recurring reminder',
  '/remind list — List active recurring reminders',
  '/remind cancel <id> — Cancel a recurring reminder',
  '',
  '/research <topic> [--audio] [--video] [--link <url>] [| <prompt>]',
  '  Deep research with NotebookLM + Claude',
  '/research-status — Check research job progress',
  '',
  '/podcast <vault-path> [--format deep-dive|brief|critique|debate] [--length short|default|long]',
  '  Generate audio podcast from a vault note',
  '  Vault path: use Obsidian "Copy vault path" (e.g. reclaw/architecture)',
  '  Defaults: --format deep-dive --length default',
].join('\n');

function routeHelpCommand(msg: IncomingMessage, deps: MessageRouterDeps): void {
  deps.telegram.sendMessage(msg.chatId, HELP_TEXT).catch((err: unknown) => {
    console.error('[router] Failed to send /help response:', err);
  });
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
