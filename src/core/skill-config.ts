import { parseExpression } from 'cron-parser';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { SKILL_ENVIRONMENT_VARIABLES } from './agent-environment.js';
import { type AgentTarget, makeClaudeModel } from './model-selection.js';
import {
  type AgentBackendName,
  type Result,
  type SkillAgent,
  type SkillConfig,
  err,
  makeSkillId,
  ok,
} from './types.js';

// ─── Zod Schema ───────────────────────────────────────────────────────────────

const SkillConfigSchema = z
  .object({
    // Optional. The authoritative id is derived from the filename; an embedded `id` is only
    // permitted if it MATCHES (validated in parseSkillConfig). This stops a renamed file from
    // silently carrying a stale id that prompt cross-references would then lie about.
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
    backend: z.enum(['claude', 'pi']).optional(),
    model: z.string().optional(),
    // `fallback: pi` or `fallback: { backend: claude, model: sonnet }`
    fallback: z
      .union([
        z.enum(['claude', 'pi']),
        z.object({ backend: z.enum(['claude', 'pi']), model: z.string().optional() }).strict(),
      ])
      .optional(),
    environment: z.array(z.enum(SKILL_ENVIRONMENT_VARIABLES)).default([]),
    dependsOn: z.string().min(1).nullable().default(null),
  })
  .refine((data) => !(data.dependsOn !== null && data.schedule !== null), {
    message: 'A skill with dependsOn must not have its own schedule',
    path: ['dependsOn'],
  });

// ─── Parsers (pure) ───────────────────────────────────────────────────────────

const MODEL_NEEDS_CLAUDE =
  'requires "backend: claude" — Pi\'s model is service-wide (RECLAW_PI_MODEL), and a model without an explicit backend would follow whatever AGENT_BACKEND is';

function parseAgentTarget(
  backend: AgentBackendName,
  model: string | undefined,
): Result<AgentTarget, string> {
  if (model === undefined) return ok({ backend });
  if (backend !== 'claude') return err(`model: ${MODEL_NEEDS_CLAUDE}`);
  const parsed = makeClaudeModel(model);
  return parsed.ok ? ok({ backend, model: parsed.value }) : err(`model: ${parsed.error}`);
}

function parseSkillAgent(
  backend: AgentBackendName | undefined,
  model: string | undefined,
): Result<SkillAgent, string> {
  if (backend !== undefined) return parseAgentTarget(backend, model);
  return model === undefined ? ok({}) : err(`model: ${MODEL_NEEDS_CLAUDE}`);
}

function parseFallback(
  primary: AgentBackendName | undefined,
  raw: AgentBackendName | { backend: AgentBackendName; model?: string | undefined } | undefined,
): Result<AgentTarget | undefined, string> {
  if (raw === undefined) return ok(undefined);
  const { backend, model } = typeof raw === 'string' ? { backend: raw, model: undefined } : raw;
  if (backend === primary) {
    return err(`fallback: must name a different backend than "backend: ${primary}"`);
  }
  const target = parseAgentTarget(backend, model);
  return target.ok ? target : err(`fallback.${target.error}`);
}

/**
 * Parse a YAML skill config file. Returns a Result<SkillConfig, string>.
 * The SkillId is derived from the filePath basename (without extension).
 */
export function parseSkillConfig(
  yamlContent: string,
  filePath: string,
): Result<SkillConfig, string> {
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
      `Skill config in "${filePath}" has id "${result.data.id}" but the filename derives "${idStr}". Remove the id field (the filename is authoritative) or rename the file to match.`,
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

  const agent = parseSkillAgent(result.data.backend, result.data.model);
  if (!agent.ok) {
    return err(`Skill config validation failed in "${filePath}": ${agent.error}`);
  }
  const fallback = parseFallback(result.data.backend, result.data.fallback);
  if (!fallback.ok) {
    return err(`Skill config validation failed in "${filePath}": ${fallback.error}`);
  }

  return ok({
    ...agent.value,
    ...(fallback.value !== undefined ? { fallback: fallback.value } : {}),
    id: idResult.value,
    name: result.data.name,
    schedule: result.data.schedule,
    promptTemplate: result.data.promptTemplate,
    permissionProfile: result.data.permissionProfile,
    validityWindowMinutes: result.data.validityWindowMinutes,
    // Only set timeout when explicitly provided — exactOptionalPropertyTypes forbids an
    // explicit `undefined`, and an absent key is exactly what signals "inherit the default".
    ...(result.data.timeout !== undefined ? { timeout: result.data.timeout } : {}),
    environment: result.data.environment,
    dependsOn: dependsOnId,
  } satisfies SkillConfig);
}

/**
 * Parse an array of file entries (path + content). Returns valid configs and
 * error strings for malformed files. Never throws. Satisfies FR-054.
 */
export function parseSkillDirectory(files: ReadonlyArray<{ path: string; content: string }>): {
  valid: readonly SkillConfig[];
  errors: readonly string[];
} {
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
