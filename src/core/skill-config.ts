import { parseExpression } from 'cron-parser';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { type Result, type SkillConfig, err, makeSkillId, ok } from './types.js';

// ─── Zod Schema ───────────────────────────────────────────────────────────────

export const SkillConfigSchema = z
  .object({
    // Optional. The authoritative id is derived from the filename; an embedded `id` is only
    // permitted if it MATCHES (validated in parseSkillConfig). This stops a renamed file from
    // silently carrying a stale id that cross-references in prompts then lie about.
    id: z.string().min(1).optional(),
    name: z.string().min(1, 'name must not be empty'),
    schedule: z
      .string()
      .nullable()
      .default(null)
      .refine(
        (v) => {
          if (v === null) return true;
          try {
            parseExpression(v);
            return true;
          } catch {
            return false;
          }
        },
        { message: 'schedule must be a valid cron expression' },
      ),
    promptTemplate: z.string().min(1, 'promptTemplate must not be empty'),
    permissionProfile: z.enum(['chat', 'scheduled']),
    validityWindowMinutes: z.number().int().positive().default(30),
    // Optional with NO default: an absent timeout must fall through to the scheduled handler's
    // SCHEDULED_TIMEOUT_MS default (20 min), not a hard 120s. A schema default here would mask
    // that fallback (scheduled-handler: `skill.timeout ? skill.timeout * 1000 : scheduledTimeoutMs`),
    // silently capping every skill that omits the field at 2 minutes.
    timeout: z.number().int().positive().optional(),
    dependsOn: z.string().min(1).nullable().default(null),
  })
  .refine((data) => !(data.dependsOn !== null && data.schedule !== null), {
    message: 'A skill with dependsOn must not have its own schedule',
    path: ['dependsOn'],
  });

// ─── Parsers (pure) ───────────────────────────────────────────────────────────

/**
 * Parse a YAML skill config file. Returns a Result<SkillConfig, string>.
 * The SkillId is derived from the filePath basename (without extension).
 */
export function parseSkillConfig(yamlContent: string, filePath: string): Result<SkillConfig, string> {
  // Derive skill id from filename
  const basename = filePath.split('/').pop() ?? filePath;
  const idStr = basename.replace(/\.ya?ml$/i, '');
  const idResult = makeSkillId(idStr);
  if (!idResult.ok) {
    return err(`Invalid skill id derived from path "${filePath}": ${idResult.error}`);
  }

  // Parse YAML
  let raw: unknown;
  try {
    raw = parseYaml(yamlContent);
  } catch (e) {
    return err(`YAML parse error in "${filePath}": ${e instanceof Error ? e.message : String(e)}`);
  }

  if (raw === null || typeof raw !== 'object') {
    return err(`Skill config in "${filePath}" must be a YAML object, got ${typeof raw}`);
  }

  // Validate with Zod
  const result = SkillConfigSchema.safeParse(raw);
  if (!result.success) {
    const msg = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return err(`Skill config validation failed in "${filePath}": ${msg}`);
  }

  // If an explicit id is present, it must match the filename-derived id.
  if (result.data.id !== undefined && result.data.id !== idStr) {
    return err(
      `Skill config in "${filePath}" has id "${result.data.id}" but the filename derives "${idStr}". ` +
        `Remove the id field (the filename is authoritative) or rename the file to match.`,
    );
  }

  // Validate dependsOn as a SkillId if present
  let dependsOnId: SkillConfig['dependsOn'] = null;
  if (result.data.dependsOn !== null) {
    if (result.data.dependsOn === idStr) {
      return err(`Skill "${filePath}" cannot depend on itself`);
    }
    const depResult = makeSkillId(result.data.dependsOn);
    if (!depResult.ok) {
      return err(`dependsOn in "${filePath}" is invalid: ${depResult.error}`);
    }
    dependsOnId = depResult.value;
  }

  return ok({
    id: idResult.value,
    name: result.data.name,
    schedule: result.data.schedule,
    promptTemplate: result.data.promptTemplate,
    permissionProfile: result.data.permissionProfile,
    validityWindowMinutes: result.data.validityWindowMinutes,
    // Only set timeout when explicitly provided — exactOptionalPropertyTypes forbids an
    // explicit `undefined`, and an absent key is exactly what signals "inherit the default".
    ...(result.data.timeout !== undefined ? { timeout: result.data.timeout } : {}),
    dependsOn: dependsOnId,
  } satisfies SkillConfig);
}

/**
 * Parse an array of file entries (path + content). Returns valid configs and
 * error strings for malformed files. Never throws. Satisfies FR-054.
 */
export function parseSkillDirectory(
  files: ReadonlyArray<{ path: string; content: string }>,
): { valid: readonly SkillConfig[]; errors: readonly string[] } {
  const valid: SkillConfig[] = [];
  const errors: string[] = [];

  for (const file of files) {
    const result = parseSkillConfig(file.content, file.path);
    if (result.ok) {
      valid.push(result.value);
    } else {
      errors.push(result.error);
    }
  }

  return { valid, errors };
}
