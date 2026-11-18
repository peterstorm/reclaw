import { z } from 'zod';
import { type Result, err, ok } from './types.js';

/**
 * The ARTEX task-completion watcher's pure domain: the task-list wire contract,
 * the completion diff against the reported state, and the page message.
 *
 * Every function here is pure and total; I/O (fetch, state files, Telegram)
 * lives in the script that drives it (`workspace/skills/artex-task-watcher.ts`).
 * The old prompt-encoded rules are now type-and-test-enforced invariants:
 * one page per transition, terminal statuses exactly done/failed/timeout,
 * prune vanished ids, never re-page an unchanged failure.
 */

// ─── Terminal statuses ────────────────────────────────────────────────────────

/** ARTEX statuses that end a task; every other status is still in flight. */
export const TERMINAL_STATUSES = ['done', 'failed', 'timeout'] as const;

export const isTerminalStatus = (status: string): boolean =>
  (TERMINAL_STATUSES as readonly string[]).includes(status);

// ─── Task list (GET /api/tasks wire) ──────────────────────────────────────────

export type ArtexTaskFindings = {
  readonly critical: number;
  readonly high: number;
  readonly medium: number;
  readonly low: number;
};

export type ArtexTask = {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly tokens?: { readonly inputTokens: number; readonly outputTokens: number };
  readonly goalsMet?: number;
  readonly goalsTotal?: number;
  readonly findings?: ArtexTaskFindings;
};

export type ArtexTaskList = {
  readonly active: string;
  readonly tasks: readonly ArtexTask[];
};

const findingsSchema = z.object({
  critical: z.number().int(),
  high: z.number().int(),
  medium: z.number().int(),
  low: z.number().int(),
});

const taskSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  name: z.string(),
  status: z.string(),
  tokens: z.object({ input_tokens: z.number().int(), output_tokens: z.number().int() }).optional(),
  goals_met: z.number().int().optional(),
  goals_total: z.number().int().optional(),
  findings: findingsSchema.optional(),
});

const taskListSchema = z.object({
  active: z.union([z.string(), z.number()]).transform(String),
  tasks: z.array(taskSchema),
});

const toTask = (t: z.infer<typeof taskSchema>): ArtexTask => ({
  id: t.id,
  name: t.name,
  status: t.status,
  ...(t.tokens !== undefined
    ? { tokens: { inputTokens: t.tokens.input_tokens, outputTokens: t.tokens.output_tokens } }
    : {}),
  ...(t.goals_met !== undefined ? { goalsMet: t.goals_met } : {}),
  ...(t.goals_total !== undefined ? { goalsTotal: t.goals_total } : {}),
  ...(t.findings !== undefined ? { findings: t.findings } : {}),
});

/**
 * Parse the GET /api/tasks response. Rejects anything without the `tasks` key
 * (the shape check the old prompt performed with grep) so a login page or
 * error body can never be mistaken for an empty task list.
 */
export function parseArtexTaskList(raw: unknown): Result<ArtexTaskList, string> {
  const parsed = taskListSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return err(`artex task list does not match the wire contract: ${issues}`);
  }
  return ok({ active: parsed.data.active, tasks: parsed.data.tasks.map(toTask) });
}

// ─── Completion diff (the page decision) ──────────────────────────────────────

/**
 * The state file's reported map: task id → last status the watcher saw for it.
 * A task is a completion when it is terminal NOW and its reported status is
 * not terminal (absent or still in flight).
 */
export type ReportedState = Readonly<Record<string, string>>;

export type TaskDiff = {
  /** Tasks to page about now, in API order. */
  readonly completions: readonly ArtexTask[];
  /** The state to persist after this run: every current task's status, ids gone from the API pruned. */
  readonly nextState: ReportedState;
};

/**
 * The one decision the watcher exists for. Pure: (reported, current) → pages.
 * Applying `nextState` and re-running yields no completions (idempotence of
 * one page per transition — property-tested).
 */
export function diffTaskCompletions(
  reported: ReportedState,
  tasks: readonly ArtexTask[],
): TaskDiff {
  return {
    completions: tasks.filter(
      (t) => isTerminalStatus(t.status) && !isTerminalStatus(reported[t.id] ?? ''),
    ),
    nextState: Object.fromEntries(tasks.map((t) => [t.id, t.status])),
  };
}

// ─── Page message ─────────────────────────────────────────────────────────────

const NAME_LIMIT = 60;
const ARTEX_URL = 'https://artex.peterstorm.io';

const truncate = (s: string, max: number): string => (s.length <= max ? s : s.slice(0, max));
const toK = (tokens: number): string => `${Math.round(tokens / 1000)}k`;

/**
 * One line per completion — counts only, never finding bodies, secrets or
 * evidence content — plus the URL footer. Empty input formats as the empty
 * string: the caller then sends nothing at all.
 */
export function formatCompletions(completions: readonly ArtexTask[]): string {
  if (completions.length === 0) return '';
  const lines = completions.map((t) => {
    const segments = [
      `#${t.id} ${truncate(t.name, NAME_LIMIT)} — ${t.status}`,
      ...(t.findings !== undefined
        ? [
            `findings C${t.findings.critical}/H${t.findings.high}/M${t.findings.medium}/L${t.findings.low}`,
          ]
        : []),
      ...(t.goalsMet !== undefined && t.goalsTotal !== undefined
        ? [`goals ${t.goalsMet}/${t.goalsTotal}`]
        : []),
      ...(t.tokens !== undefined
        ? [`tokens ${toK(t.tokens.inputTokens)}/${toK(t.tokens.outputTokens)}`]
        : []),
    ];
    return segments.join(', ');
  });
  return `${lines.join('\n')}\n${ARTEX_URL}`;
}

// ─── Failure dedupe (the error file's fingerprint) ────────────────────────────

/** Why one run could not check ARTEX. Exactly the old prompt's cause set. */
export type ArtexWatchFailureCause = 'login-failed' | 'api-unreachable' | 'fetch-unusable';
export const ARTEX_WATCH_FAILURE_CAUSES: readonly ArtexWatchFailureCause[] = [
  'login-failed',
  'api-unreachable',
  'fetch-unusable',
];

/**
 * Page only when this failure is new or the cause changed; an unchanged cause
 * was already reported — never re-page it.
 */
export function shouldPageFailure(
  recorded: ArtexWatchFailureCause | undefined,
  cause: ArtexWatchFailureCause,
): boolean {
  return recorded !== cause;
}

/** The `{ cause }` record the error file holds; undefined on any other shape. */
export function parseFailureRecord(raw: unknown): ArtexWatchFailureCause | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const cause = (raw as { readonly cause?: unknown }).cause;
  return ARTEX_WATCH_FAILURE_CAUSES.find((c) => c === cause);
}

// ─── Login token (POST /api/auth/login wire) ────────────────────────────

const loginBodySchema = z.object({ token: z.string().min(1) });

/** The bearer token of a successful login response; undefined on any other shape. */
export function parseLoginToken(raw: unknown): string | undefined {
  const parsed = loginBodySchema.safeParse(raw);
  return parsed.success ? parsed.data.token : undefined;
}

// ─── Reported state (the watcher's state file) ────────────────────────────────

const reportedStateSchema = z.object({ reported: z.record(z.string()) });

/** Parse the state file's JSON. A corrupt file fails closed to the silent baseline. */
export function parseReportedState(raw: unknown): Result<ReportedState, string> {
  const parsed = reportedStateSchema.safeParse(raw);
  return parsed.success
    ? ok(parsed.data.reported)
    : err('reported state must be { reported: Record<string, string> }');
}

/** Serialize the state for the state file. */
export function serializeReportedState(state: ReportedState): string {
  return JSON.stringify({ reported: state }, null, 2);
}
