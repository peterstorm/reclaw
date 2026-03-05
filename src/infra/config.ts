import { z } from 'zod';
import { type Result, err, ok } from '../core/types.js';

// ─── Schema ───────────────────────────────────────────────────────────────────

export const AppConfigSchema = z.object({
  telegramToken: z.string().min(1),
  authorizedUserIds: z.array(z.number().int().positive()).min(1),
  redisHost: z.string().default('localhost'),
  redisPort: z.number().int().min(1).max(65535).default(6379),
  workspacePath: z.string().default('/workspace'),
  skillsDir: z.string().default('/workspace/skills'),
  personalityPath: z.string().default('/workspace/personality.md'),
  claudeBinaryPath: z.string().default('claude'),
  chatTimeoutMs: z.number().int().positive().default(3_600_000), // 1 hour
  scheduledTimeoutMs: z.number().int().positive().default(1_200_000), // 20 minutes
  geminiApiKey: z.string().optional(),
  sessionIdleTimeoutMs: z.number().int().positive().default(1_800_000), // 30min
  notebooklmAuthToken: z.string().optional(),
  notebooklmCookies: z.string().optional(),
  researchTimeoutMs: z.number().int().positive().default(1_500_000), // 25 minutes
  obsidianVaultPath: z.string().optional(),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

// ─── Env parsing (pure) ───────────────────────────────────────────────────────

/**
 * Parse a numeric env var. Returns the integer value, undefined if not set,
 * or pushes an error message to `errors` if set but not a valid integer.
 */
function parseNumericEnv(
  key: string,
  raw: string | undefined,
  errors: string[],
): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (Number.isNaN(n) || !Number.isInteger(n)) {
    errors.push(`${key}: must be a valid integer, got "${raw}"`);
    return undefined;
  }
  return n;
}

/**
 * Parse a comma-separated list of positive integer IDs from an env var.
 * Returns the array of numbers, or pushes errors for any invalid entries.
 */
function parseCommaSeparatedIds(
  key: string,
  raw: string | undefined,
  errors: string[],
): number[] | undefined {
  if (raw === undefined || raw === '') return undefined;
  const parts = raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
  const ids: number[] = [];
  for (const part of parts) {
    const n = Number(part);
    if (Number.isNaN(n) || !Number.isInteger(n) || n <= 0) {
      errors.push(`${key}: each entry must be a positive integer, got "${part}"`);
      return undefined;
    }
    ids.push(n);
  }
  return ids.length > 0 ? ids : undefined;
}

export function parseEnvToRaw(
  env: Record<string, string | undefined>,
): { raw: Record<string, unknown>; errors: string[] } {
  const errors: string[] = [];
  const raw: Record<string, unknown> = {
    telegramToken: env['TELEGRAM_TOKEN'],
    authorizedUserIds: parseCommaSeparatedIds('AUTHORIZED_USER_IDS', env['AUTHORIZED_USER_IDS'], errors),
    redisHost: env['REDIS_HOST'],
    redisPort: parseNumericEnv('REDIS_PORT', env['REDIS_PORT'], errors),
    workspacePath: env['WORKSPACE_PATH'],
    skillsDir: env['SKILLS_DIR'],
    personalityPath: env['PERSONALITY_PATH'],
    claudeBinaryPath: env['CLAUDE_BINARY_PATH'],
    chatTimeoutMs: parseNumericEnv(
      'CHAT_TIMEOUT_MS',
      env['CHAT_TIMEOUT_MS'],
      errors,
    ),
    scheduledTimeoutMs: parseNumericEnv(
      'SCHEDULED_TIMEOUT_MS',
      env['SCHEDULED_TIMEOUT_MS'],
      errors,
    ),
    geminiApiKey: env['GEMINI_API_KEY'],
    sessionIdleTimeoutMs: parseNumericEnv(
      'SESSION_IDLE_TIMEOUT_MS',
      env['SESSION_IDLE_TIMEOUT_MS'],
      errors,
    ),
    notebooklmAuthToken: env['NOTEBOOKLM_AUTH_TOKEN'],
    notebooklmCookies: env['NOTEBOOKLM_COOKIES'],
    researchTimeoutMs: parseNumericEnv(
      'RESEARCH_TIMEOUT_MS',
      env['RESEARCH_TIMEOUT_MS'],
      errors,
    ),
    obsidianVaultPath: env['OBSIDIAN_VAULT_PATH'],
  };
  return { raw, errors };
}

// ─── Loader (imperative shell) ────────────────────────────────────────────────

export function loadConfig(env: Record<string, string | undefined> = process.env): Result<AppConfig, string> {
  const { raw, errors } = parseEnvToRaw(env);

  if (errors.length > 0) {
    return err(`Config validation failed: ${errors.join('; ')}`);
  }

  const parsed = AppConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return err(`Config validation failed: ${msg}`);
  }
  return ok(parsed.data);
}
