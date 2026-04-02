// ─── Workout JSON Validation ──────────────────────────────────────────────────
//
// Validates Garmin IWorkoutDetail JSON structure before submission to the API.
// Pure validation — no API calls, no side effects.

import type { Result } from './types.js';

// ─── Types (subset of Garmin IWorkoutDetail) ─────────────────────────────────

interface StepType {
  readonly stepTypeId: number;
  readonly stepTypeKey: string;
  readonly displayOrder: number;
}

interface EndCondition {
  readonly conditionTypeId: number;
  readonly conditionTypeKey: string;
}

interface TargetType {
  readonly workoutTargetTypeId: number;
  readonly workoutTargetTypeKey: string;
}

interface ExecutableStep {
  readonly type: 'ExecutableStepDTO';
  readonly stepOrder: number;
  readonly stepType: StepType;
  readonly endCondition: EndCondition;
  readonly endConditionValue: number | null;
  readonly targetType: TargetType | null;
  readonly targetValueOne: number | null;
  readonly targetValueTwo: number | null;
}

interface RepeatGroup {
  readonly type: 'RepeatGroupDTO';
  readonly stepOrder: number;
  readonly stepType: StepType;
  readonly numberOfIterations: number;
  readonly workoutSteps: ReadonlyArray<WorkoutStep>;
  readonly endCondition: EndCondition;
  readonly endConditionValue: number;
}

type WorkoutStep = ExecutableStep | RepeatGroup;

interface WorkoutSegment {
  readonly segmentOrder: number;
  readonly workoutSteps: ReadonlyArray<WorkoutStep>;
}

interface WorkoutJson {
  readonly workoutName: string;
  readonly sportType: { readonly sportTypeId: number; readonly sportTypeKey: string };
  readonly workoutSegments: ReadonlyArray<WorkoutSegment>;
  readonly estimatedDistanceInMeters?: number | null;
  readonly description?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const VALID_STEP_TYPE_IDS = new Set([1, 2, 3, 4, 5, 6]); // warmup, cooldown, interval, recovery, rest, repeat
const VALID_STEP_TYPE_KEYS = new Set(['warmup', 'cooldown', 'interval', 'recovery', 'rest', 'repeat']);
const VALID_CONDITION_TYPE_IDS = new Set([1, 2, 3, 7]); // lap.button, time, distance, iterations

// ─── Validation ──────────────────────────────────────────────────────────────

/** Validate a workout JSON structure. Returns list of issues found. */
export function validateWorkoutJson(json: unknown): Result<void, string[]> {
  const errors: string[] = [];

  if (typeof json !== 'object' || json === null) {
    return { ok: false, error: ['Workout JSON must be a non-null object'] };
  }

  const w = json as Record<string, unknown>;

  // Top-level fields
  if (typeof w['workoutName'] !== 'string' || w['workoutName'].length === 0) {
    errors.push('workoutName must be a non-empty string');
  }

  if (typeof w['sportType'] !== 'object' || w['sportType'] === null) {
    errors.push('sportType must be an object');
  } else {
    const st = w['sportType'] as Record<string, unknown>;
    if (st['sportTypeKey'] !== 'running') {
      errors.push(`sportType.sportTypeKey must be "running", got "${String(st['sportTypeKey'])}"`);
    }
  }

  if (!Array.isArray(w['workoutSegments']) || w['workoutSegments'].length === 0) {
    errors.push('workoutSegments must be a non-empty array');
    return { ok: false, error: errors };
  }

  // Validate segments
  for (const [si, segment] of (w['workoutSegments'] as unknown[]).entries()) {
    const seg = segment as Record<string, unknown>;
    if (!Array.isArray(seg['workoutSteps']) || seg['workoutSteps'].length === 0) {
      errors.push(`Segment ${si}: workoutSteps must be a non-empty array`);
      continue;
    }

    const stepOrders: number[] = [];
    validateSteps(seg['workoutSteps'] as unknown[], `segment[${si}]`, errors, stepOrders);

    // Check step order is sequential
    for (let i = 1; i < stepOrders.length; i++) {
      if (stepOrders[i]! <= stepOrders[i - 1]!) {
        errors.push(
          `Step order not sequential: ${stepOrders[i - 1]} → ${stepOrders[i]} in ${`segment[${si}]`}`,
        );
      }
    }
  }

  return errors.length === 0 ? { ok: true, value: undefined } : { ok: false, error: errors };
}

function validateSteps(
  steps: unknown[],
  path: string,
  errors: string[],
  stepOrders: number[],
): void {
  for (const [i, step] of steps.entries()) {
    const s = step as Record<string, unknown>;
    const stepPath = `${path}.step[${i}]`;

    if (s['type'] === 'ExecutableStepDTO') {
      validateExecutableStep(s, stepPath, errors, stepOrders);
    } else if (s['type'] === 'RepeatGroupDTO') {
      validateRepeatGroup(s, stepPath, errors, stepOrders);
    } else {
      errors.push(`${stepPath}: unknown step type "${String(s['type'])}"`);
    }
  }
}

function validateExecutableStep(
  s: Record<string, unknown>,
  path: string,
  errors: string[],
  stepOrders: number[],
): void {
  // stepOrder
  if (typeof s['stepOrder'] !== 'number' || s['stepOrder'] < 1) {
    errors.push(`${path}: stepOrder must be a positive number`);
  } else {
    stepOrders.push(s['stepOrder'] as number);
  }

  // stepType
  const st = s['stepType'] as Record<string, unknown> | undefined;
  if (!st) {
    errors.push(`${path}: stepType is required`);
  } else {
    if (!VALID_STEP_TYPE_IDS.has(st['stepTypeId'] as number)) {
      errors.push(`${path}: invalid stepTypeId ${String(st['stepTypeId'])}`);
    }
    if (!VALID_STEP_TYPE_KEYS.has(st['stepTypeKey'] as string)) {
      errors.push(`${path}: invalid stepTypeKey "${String(st['stepTypeKey'])}"`);
    }
  }

  // endCondition
  const ec = s['endCondition'] as Record<string, unknown> | undefined;
  if (!ec) {
    errors.push(`${path}: endCondition is required`);
  } else if (!VALID_CONDITION_TYPE_IDS.has(ec['conditionTypeId'] as number)) {
    errors.push(`${path}: invalid conditionTypeId ${String(ec['conditionTypeId'])}`);
  }

  // Cooldown with lap.button must have null endConditionValue
  if (ec && ec['conditionTypeKey'] === 'lap.button' && s['endConditionValue'] !== null) {
    errors.push(`${path}: cooldown with lap.button must have endConditionValue: null`);
  }

  // Distance steps need preferredEndConditionUnit
  if (ec && ec['conditionTypeKey'] === 'distance') {
    const unit = s['preferredEndConditionUnit'] as Record<string, unknown> | null;
    if (!unit || unit['unitKey'] !== 'kilometer') {
      errors.push(`${path}: distance steps must have preferredEndConditionUnit with unitKey "kilometer"`);
    }
  }

  // Rest steps must have targetType: null
  if (st && st['stepTypeKey'] === 'rest' && s['targetType'] !== null) {
    errors.push(`${path}: rest steps must have targetType: null`);
  }

  // Pace-targeted steps need both values
  const tt = s['targetType'] as Record<string, unknown> | null;
  if (tt && tt['workoutTargetTypeKey'] === 'pace.zone') {
    if (typeof s['targetValueOne'] !== 'number' || typeof s['targetValueTwo'] !== 'number') {
      errors.push(`${path}: pace.zone targets require numeric targetValueOne and targetValueTwo`);
    } else if (s['targetValueOne'] as number <= s['targetValueTwo'] as number) {
      // targetValueOne (fast) should be > targetValueTwo (slow) in m/s
      errors.push(
        `${path}: targetValueOne (fast, ${s['targetValueOne']}) must be > targetValueTwo (slow, ${s['targetValueTwo']})`,
      );
    }
  }
}

function validateRepeatGroup(
  s: Record<string, unknown>,
  path: string,
  errors: string[],
  stepOrders: number[],
): void {
  if (typeof s['stepOrder'] !== 'number' || s['stepOrder'] < 1) {
    errors.push(`${path}: stepOrder must be a positive number`);
  } else {
    stepOrders.push(s['stepOrder'] as number);
  }

  const st = s['stepType'] as Record<string, unknown> | undefined;
  if (!st || st['stepTypeKey'] !== 'repeat' || st['stepTypeId'] !== 6) {
    errors.push(`${path}: RepeatGroupDTO must have stepType repeat (id=6)`);
  }

  if (typeof s['numberOfIterations'] !== 'number' || s['numberOfIterations'] < 1) {
    errors.push(`${path}: numberOfIterations must be a positive number`);
  }

  const ec = s['endCondition'] as Record<string, unknown> | undefined;
  if (!ec || ec['conditionTypeKey'] !== 'iterations') {
    errors.push(`${path}: RepeatGroupDTO must have endCondition "iterations"`);
  }

  if (s['numberOfIterations'] !== s['endConditionValue']) {
    errors.push(`${path}: numberOfIterations (${s['numberOfIterations']}) must match endConditionValue (${s['endConditionValue']})`);
  }

  const children = s['workoutSteps'] as unknown[] | undefined;
  if (!Array.isArray(children) || children.length === 0) {
    errors.push(`${path}: RepeatGroupDTO must have non-empty workoutSteps`);
  } else {
    // Validate children share the same childStepId
    const childIds = new Set<unknown>();
    for (const child of children) {
      childIds.add((child as Record<string, unknown>)['childStepId']);
    }
    if (childIds.size > 1) {
      errors.push(`${path}: all children must share the same childStepId`);
    }

    validateSteps(children, path, errors, stepOrders);
  }
}
