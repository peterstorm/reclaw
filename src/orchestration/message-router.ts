import { makeTelegramUserId, makeChatJob, makeJobId, makeReminderJob, makeRecurringReminderJob } from '../core/types.js';
import { parseRemindCommand, isRemindListCommand, parseRemindCancelCommand, formatDuration, formatAbsoluteTime, formatSemanticDate } from '../core/reminder.js';
import { parseResearchCommand } from '../core/research-request.js';
import { makeResearchJobData } from '../core/research-types.js';
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
};

export type MessageRouterDeps = {
  readonly telegram: TelegramAdapter;
  readonly sessionStore: SessionStore;
  readonly queues: Queues;
  readonly quotaTracker: QuotaTracker;
};

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

  // ── /new — clear session ──
  if (msg.text.trim() === '/new') {
    deps.sessionStore.deleteSession(msg.chatId).then(() => {
      return deps.telegram.sendMessage(msg.chatId, 'Session cleared. Next message starts a fresh conversation.');
    }).catch((err: unknown) => {
      console.error('[router] Failed to handle /new command:', err);
    });
    return;
  }

  // ── /remind family ──
  if (msg.text.trim().startsWith('/remind')) {
    routeRemindCommand(msg, deps);
    return;
  }

  // ── /research-status ──
  if (msg.text.trim().toLowerCase() === '/research-status') {
    routeResearchStatus(msg, deps);
    return;
  }

  // ── /research <topic> ──
  if (msg.text.trim().toLowerCase().startsWith('/research')) {
    routeResearchCommand(msg, deps);
    return;
  }

  // ── Reply-to-message routing + default chat ──
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
}

// ─── /remind sub-router ──────────────────────────────────────────────────────

function routeRemindCommand(msg: IncomingMessage, deps: MessageRouterDeps): void {
  // /remind list
  if (isRemindListCommand(msg.text)) {
    deps.queues.listRecurringReminders()
      .then((reminders) => {
        const mine = reminders.filter((r) => r.chatId === msg.chatId);
        if (mine.length === 0) {
          return deps.telegram.sendMessage(msg.chatId, 'No active recurring reminders.');
        }
        const lines = mine.map((r, i) => {
          const schedule = r.cronDescription ?? (r.cronPattern ? r.cronPattern : `every ${formatDuration(r.intervalMs)}`);
          return `${i + 1}. \`${r.schedulerId}\` ${schedule} — ${r.text}`;
        });
        const listMsg = `Active recurring reminders:\n\n${lines.join('\n')}\n\nCancel with: /remind cancel <id>`;
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
        const confirmMsg = recurParsed.kind === 'cron-recurring'
          ? `Got it — I'll remind you ${recurParsed.cronDescription} to: ${recurParsed.text}`
          : `Got it — I'll remind you every ${formatDuration(recurParsed.intervalMs)} to: ${recurParsed.text}`;
        return deps.telegram.sendMessage(msg.chatId, confirmMsg);
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
      const confirmMsg =
        parsed.kind === 'duration'
          ? `Got it — I'll remind you in ${formatDuration(parsed.delayMs)}.`
          : parsed.kind === 'absolute'
            ? `Got it — I'll remind you at ${formatAbsoluteTime(parsed.delayMs)}.`
            : `Got it — I'll remind you on ${formatSemanticDate(parsed.delayMs)}.`;
      return deps.telegram.sendMessage(msg.chatId, confirmMsg);
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
  const researchParseResult = parseResearchCommand(msg.text);

  if (!researchParseResult.ok) {
    deps.telegram.sendMessage(msg.chatId, researchParseResult.error).catch((parseErr: unknown) => {
      console.error('[router] Failed to send /research parse error:', parseErr);
    });
    return;
  }

  const { topic, sourceHints, generateAudio, generateVideo } = researchParseResult.value;

  deps.quotaTracker.hasQuota(5).then(async (hasEnoughQuota) => {
    if (!hasEnoughQuota) {
      await deps.telegram.sendMessage(msg.chatId, 'Cannot enqueue research job: daily chat quota too low (need at least 5 remaining).');
      return;
    }

    const researchJobDataResult = makeResearchJobData({
      topic,
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

    const confirmMsg = position > 1
      ? `Research enqueued: "${topic}"\n\nQueue position: ${position} (${position - 1} job(s) ahead)${mediaSuffix}`
      : `Research enqueued: "${topic}"\n\nStarting now.${mediaSuffix}`;

    await deps.telegram.sendMessage(msg.chatId, confirmMsg);
  }).catch((researchErr: unknown) => {
    console.error('[router] Failed to enqueue research job:', researchErr);
    deps.telegram.sendMessage(msg.chatId, 'An unexpected error occurred while enqueuing your research job. Please try again.').catch((e: unknown) => {
      console.error('[router] Failed to send research error notification:', e);
    });
  });
}
