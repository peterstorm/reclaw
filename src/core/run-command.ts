// ─── /run Command ───────────────────────────────────────────────────────────────
//
// The pure half of a manual skill trigger: parse `/run <skill-id>`, find the
// skill in a registry snapshot, time-box the run, and word each rejection.
// The router supplies the registry and the clock, and enqueues the job.

import {
  type Result,
  type SkillConfig,
  type SkillId,
  type SkillRegistry,
  assertNever,
  err,
  makeSkillId,
  ok,
} from './types.js';

/** Why a /run command does not trigger a skill. */
export type RunRejection =
  | { readonly kind: 'registry-unavailable' }
  | { readonly kind: 'missing-skill-id' }
  | { readonly kind: 'invalid-skill-id'; readonly rawSkillId: string; readonly reason: string }
  | {
      readonly kind: 'unknown-skill';
      readonly skillId: SkillId;
      readonly knownSkillIds: readonly SkillId[];
    };

/** Known skills an unknown-skill reply names, so a large registry stays one message. */
const KNOWN_SKILLS_LISTED = 20;

/** The skill id a /run command names. */
export function parseRunCommand(text: string): Result<SkillId, RunRejection> {
  const rawSkillId = text.trim().split(/\s+/)[1];
  if (!rawSkillId) return err({ kind: 'missing-skill-id' });
  const skillId = makeSkillId(rawSkillId);
  return skillId.ok
    ? skillId
    : err({ kind: 'invalid-skill-id', rawSkillId, reason: skillId.error });
}

/** The registered skill for `skillId`, or the ids that are registered. */
export function findRunSkill(
  registry: SkillRegistry,
  skillId: SkillId,
): Result<SkillConfig, RunRejection> {
  const skill = registry.get(skillId);
  return skill === undefined
    ? err({ kind: 'unknown-skill', skillId, knownSkillIds: [...registry.keys()] })
    : ok(skill);
}

/** The reply to a rejected /run. */
export function formatRunRejection(rejection: RunRejection): string {
  switch (rejection.kind) {
    case 'registry-unavailable':
      return 'Skill registry not available — /run is disabled.';
    case 'missing-skill-id':
      return 'Usage: /run <skill-id>\nUse /status to see how many skills are loaded; check workspace/skills/ for IDs.';
    case 'invalid-skill-id':
      return `Invalid skill id "${rejection.rawSkillId}": ${rejection.reason}`;
    case 'unknown-skill': {
      const known = rejection.knownSkillIds.slice(0, KNOWN_SKILLS_LISTED).join(', ');
      return `Unknown skill "${rejection.skillId}". Known: ${known}`;
    }
    default:
      return assertNever(rejection);
  }
}

/** When a manual run triggers and until when it may still start (ISO 8601). */
export type ManualRunWindow = { readonly triggeredAt: string; readonly validUntil: string };

/** A manual run triggers at `now` (whole seconds) and stays valid for the skill's window. */
export function manualRunWindow(now: Date, validityWindowMinutes: number): ManualRunWindow {
  const triggeredAt = new Date(now);
  triggeredAt.setMilliseconds(0);
  return {
    triggeredAt: triggeredAt.toISOString(),
    validUntil: new Date(triggeredAt.getTime() + validityWindowMinutes * 60 * 1000).toISOString(),
  };
}
