import { describe, expect, it } from 'vitest';
import { validateWorkoutJson } from './workout-json.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal valid easy run workout */
function easyRun(): Record<string, unknown> {
  return {
    workoutName: 'Tue Easy Run — 8km',
    description: 'Easy aerobic run.',
    sportType: { sportTypeId: 1, sportTypeKey: 'running', displayOrder: 1 },
    estimatedDistanceInMeters: 8000,
    workoutSegments: [{
      segmentOrder: 1,
      sportType: { sportTypeId: 1, sportTypeKey: 'running', displayOrder: 1 },
      workoutSteps: [{
        type: 'ExecutableStepDTO',
        stepId: null,
        stepOrder: 1,
        stepType: { stepTypeId: 3, stepTypeKey: 'interval', displayOrder: 3 },
        childStepId: null,
        description: '8km easy run',
        endCondition: { conditionTypeId: 3, conditionTypeKey: 'distance', displayOrder: 3, displayable: true },
        endConditionValue: 8000,
        preferredEndConditionUnit: { unitId: 2, unitKey: 'kilometer', factor: 100000 },
        targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: 'no.target', displayOrder: 1 },
        targetValueOne: null,
        targetValueTwo: null,
      }],
    }],
  };
}

/** Interval workout with warmup, rest, repeat group, cooldown */
function intervalWorkout(): Record<string, unknown> {
  return {
    workoutName: 'Thu Intervals — 6×600m (~8km)',
    description: '6 × 600m at 4:55/km',
    sportType: { sportTypeId: 1, sportTypeKey: 'running', displayOrder: 1 },
    estimatedDistanceInMeters: 8000,
    workoutSegments: [{
      segmentOrder: 1,
      sportType: { sportTypeId: 1, sportTypeKey: 'running', displayOrder: 1 },
      workoutSteps: [
        {
          type: 'ExecutableStepDTO',
          stepId: null,
          stepOrder: 1,
          stepType: { stepTypeId: 1, stepTypeKey: 'warmup', displayOrder: 1 },
          childStepId: null,
          description: '2km easy warmup',
          endCondition: { conditionTypeId: 3, conditionTypeKey: 'distance', displayOrder: 3, displayable: true },
          endConditionValue: 2000,
          preferredEndConditionUnit: { unitId: 2, unitKey: 'kilometer', factor: 100000 },
          targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: 'no.target', displayOrder: 1 },
          targetValueOne: null,
          targetValueTwo: null,
        },
        {
          type: 'ExecutableStepDTO',
          stepId: null,
          stepOrder: 2,
          stepType: { stepTypeId: 5, stepTypeKey: 'rest', displayOrder: 5 },
          childStepId: null,
          description: '90s walking rest',
          endCondition: { conditionTypeId: 2, conditionTypeKey: 'time', displayOrder: 2, displayable: true },
          endConditionValue: 90,
          preferredEndConditionUnit: null,
          targetType: null,
          targetValueOne: null,
          targetValueTwo: null,
        },
        {
          type: 'RepeatGroupDTO',
          stepId: null,
          stepOrder: 3,
          stepType: { stepTypeId: 6, stepTypeKey: 'repeat', displayOrder: 6 },
          childStepId: 1,
          numberOfIterations: 6,
          workoutSteps: [
            {
              type: 'ExecutableStepDTO',
              stepId: null,
              stepOrder: 4,
              stepType: { stepTypeId: 3, stepTypeKey: 'interval', displayOrder: 3 },
              childStepId: 1,
              description: '600m at 4:55/km',
              endCondition: { conditionTypeId: 3, conditionTypeKey: 'distance', displayOrder: 3, displayable: true },
              endConditionValue: 600,
              preferredEndConditionUnit: { unitId: 2, unitKey: 'kilometer', factor: 100000 },
              targetType: { workoutTargetTypeId: 6, workoutTargetTypeKey: 'pace.zone', displayOrder: 6 },
              targetValueOne: 3.5087719,
              targetValueTwo: 3.2786885,
            },
            {
              type: 'ExecutableStepDTO',
              stepId: null,
              stepOrder: 5,
              stepType: { stepTypeId: 5, stepTypeKey: 'rest', displayOrder: 5 },
              childStepId: 1,
              description: '90s walking rest',
              endCondition: { conditionTypeId: 2, conditionTypeKey: 'time', displayOrder: 2, displayable: true },
              endConditionValue: 90,
              preferredEndConditionUnit: null,
              targetType: null,
              targetValueOne: null,
              targetValueTwo: null,
            },
          ],
          endConditionValue: 6,
          preferredEndConditionUnit: null,
          endCondition: { conditionTypeId: 7, conditionTypeKey: 'iterations', displayOrder: 7, displayable: false },
          smartRepeat: false,
        },
        {
          type: 'ExecutableStepDTO',
          stepId: null,
          stepOrder: 6,
          stepType: { stepTypeId: 2, stepTypeKey: 'cooldown', displayOrder: 2 },
          childStepId: null,
          description: 'Easy cooldown jog',
          endCondition: { conditionTypeId: 1, conditionTypeKey: 'lap.button', displayOrder: 1, displayable: true },
          endConditionValue: null,
          preferredEndConditionUnit: null,
          targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: 'no.target', displayOrder: 1 },
          targetValueOne: null,
          targetValueTwo: null,
        },
      ],
    }],
  };
}

// ─── Valid workouts ──────────────────────────────────────────────────────────

describe('validateWorkoutJson — valid workouts', () => {
  it('accepts a simple easy run', () => {
    const result = validateWorkoutJson(easyRun());
    expect(result.ok).toBe(true);
  });

  it('accepts an interval workout with repeat groups', () => {
    const result = validateWorkoutJson(intervalWorkout());
    expect(result.ok).toBe(true);
  });
});

// ─── Top-level validation ────────────────────────────────────────────────────

describe('validateWorkoutJson — top-level fields', () => {
  it('rejects null input', () => {
    const r = validateWorkoutJson(null);
    expect(r.ok).toBe(false);
  });

  it('rejects missing workoutName', () => {
    const w = easyRun();
    delete w['workoutName'];
    const r = validateWorkoutJson(w);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.some(e => e.includes('workoutName'))).toBe(true);
  });

  it('rejects empty workoutName', () => {
    const w = easyRun();
    w['workoutName'] = '';
    const r = validateWorkoutJson(w);
    expect(r.ok).toBe(false);
  });

  it('rejects non-running sportType', () => {
    const w = easyRun();
    w['sportType'] = { sportTypeId: 2, sportTypeKey: 'cycling', displayOrder: 2 };
    const r = validateWorkoutJson(w);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.some(e => e.includes('running'))).toBe(true);
  });

  it('rejects empty workoutSegments', () => {
    const w = easyRun();
    w['workoutSegments'] = [];
    const r = validateWorkoutJson(w);
    expect(r.ok).toBe(false);
  });
});

// ─── Step validation ─────────────────────────────────────────────────────────

describe('validateWorkoutJson — step validation', () => {
  it('rejects unknown step type', () => {
    const w = easyRun();
    (w['workoutSegments'] as Array<Record<string, unknown>>)[0]!['workoutSteps'] = [{
      type: 'UnknownDTO',
      stepOrder: 1,
    }];
    const r = validateWorkoutJson(w);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.some(e => e.includes('UnknownDTO'))).toBe(true);
  });

  it('rejects invalid stepTypeId', () => {
    const w = easyRun();
    const steps = (w['workoutSegments'] as Array<Record<string, unknown>>)[0]!['workoutSteps'] as Array<Record<string, unknown>>;
    (steps[0]!['stepType'] as Record<string, unknown>)['stepTypeId'] = 99;
    const r = validateWorkoutJson(w);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.some(e => e.includes('stepTypeId'))).toBe(true);
  });

  it('rejects rest step with non-null targetType', () => {
    const w = intervalWorkout();
    const steps = (w['workoutSegments'] as Array<Record<string, unknown>>)[0]!['workoutSteps'] as Array<Record<string, unknown>>;
    // Step index 1 is the rest step
    steps[1]!['targetType'] = { workoutTargetTypeId: 1, workoutTargetTypeKey: 'no.target', displayOrder: 1 };
    const r = validateWorkoutJson(w);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.some(e => e.includes('rest') && e.includes('targetType'))).toBe(true);
  });

  it('rejects distance step without preferredEndConditionUnit', () => {
    const w = easyRun();
    const steps = (w['workoutSegments'] as Array<Record<string, unknown>>)[0]!['workoutSteps'] as Array<Record<string, unknown>>;
    steps[0]!['preferredEndConditionUnit'] = null;
    const r = validateWorkoutJson(w);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.some(e => e.includes('kilometer'))).toBe(true);
  });

  it('rejects cooldown with non-null endConditionValue on lap.button', () => {
    const w = intervalWorkout();
    const steps = (w['workoutSegments'] as Array<Record<string, unknown>>)[0]!['workoutSteps'] as Array<Record<string, unknown>>;
    // Last step is cooldown
    steps[3]!['endConditionValue'] = 2000;
    const r = validateWorkoutJson(w);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.some(e => e.includes('lap.button'))).toBe(true);
  });
});

// ─── Pace target validation ──────────────────────────────────────────────────

describe('validateWorkoutJson — pace targets', () => {
  it('rejects pace.zone with missing targetValues', () => {
    const w = intervalWorkout();
    const steps = (w['workoutSegments'] as Array<Record<string, unknown>>)[0]!['workoutSteps'] as Array<Record<string, unknown>>;
    const repeatGroup = steps[2] as Record<string, unknown>;
    const children = repeatGroup['workoutSteps'] as Array<Record<string, unknown>>;
    children[0]!['targetValueOne'] = null;
    const r = validateWorkoutJson(w);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.some(e => e.includes('pace.zone'))).toBe(true);
  });

  it('rejects pace.zone with inverted values (slow > fast)', () => {
    const w = intervalWorkout();
    const steps = (w['workoutSegments'] as Array<Record<string, unknown>>)[0]!['workoutSteps'] as Array<Record<string, unknown>>;
    const repeatGroup = steps[2] as Record<string, unknown>;
    const children = repeatGroup['workoutSteps'] as Array<Record<string, unknown>>;
    // Swap: targetValueOne should be higher (faster) than targetValueTwo
    children[0]!['targetValueOne'] = 3.0;
    children[0]!['targetValueTwo'] = 3.5;
    const r = validateWorkoutJson(w);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.some(e => e.includes('targetValueOne'))).toBe(true);
  });
});

// ─── Repeat group validation ─────────────────────────────────────────────────

describe('validateWorkoutJson — repeat groups', () => {
  it('rejects repeat group with mismatched numberOfIterations and endConditionValue', () => {
    const w = intervalWorkout();
    const steps = (w['workoutSegments'] as Array<Record<string, unknown>>)[0]!['workoutSteps'] as Array<Record<string, unknown>>;
    (steps[2] as Record<string, unknown>)['numberOfIterations'] = 8;
    // endConditionValue is still 6
    const r = validateWorkoutJson(w);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.some(e => e.includes('numberOfIterations'))).toBe(true);
  });

  it('rejects repeat group with empty workoutSteps', () => {
    const w = intervalWorkout();
    const steps = (w['workoutSegments'] as Array<Record<string, unknown>>)[0]!['workoutSteps'] as Array<Record<string, unknown>>;
    (steps[2] as Record<string, unknown>)['workoutSteps'] = [];
    const r = validateWorkoutJson(w);
    expect(r.ok).toBe(false);
  });

  it('rejects repeat group with mixed childStepIds', () => {
    const w = intervalWorkout();
    const steps = (w['workoutSegments'] as Array<Record<string, unknown>>)[0]!['workoutSteps'] as Array<Record<string, unknown>>;
    const repeatGroup = steps[2] as Record<string, unknown>;
    const children = repeatGroup['workoutSteps'] as Array<Record<string, unknown>>;
    children[1]!['childStepId'] = 99; // different from children[0] which is 1
    const r = validateWorkoutJson(w);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.some(e => e.includes('childStepId'))).toBe(true);
  });
});

// ─── Step order validation ───────────────────────────────────────────────────

describe('validateWorkoutJson — step ordering', () => {
  it('rejects non-sequential step orders', () => {
    const w = intervalWorkout();
    const steps = (w['workoutSegments'] as Array<Record<string, unknown>>)[0]!['workoutSteps'] as Array<Record<string, unknown>>;
    // Set cooldown (last step) to stepOrder 3 (same as repeat group)
    steps[3]!['stepOrder'] = 3;
    const r = validateWorkoutJson(w);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.some(e => e.includes('sequential'))).toBe(true);
  });
});
