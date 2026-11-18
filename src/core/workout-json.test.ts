import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { defined } from './__fixtures__/defined.js';
import { assertNever } from './types.js';
import {
  type NonEmpty,
  type StepEnd,
  type StepSpec,
  type StepTarget,
  type WorkoutSpec,
  parseWorkoutJson,
  validateWorkoutJson,
} from './workout-json.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** The first segment of a fixture workout, for corrupting in place. */
function firstSegment(w: Record<string, unknown>): Record<string, unknown> {
  return defined((w.workoutSegments as Array<Record<string, unknown>>)[0], 'a first segment');
}

/** The first segment's step list of a fixture workout, for corrupting in place. */
function firstSegmentSteps(w: Record<string, unknown>): Array<Record<string, unknown>> {
  return firstSegment(w).workoutSteps as Array<Record<string, unknown>>;
}

/** Minimal valid easy run workout */
function easyRun(): Record<string, unknown> {
  return {
    workoutName: 'Tue Easy Run — 8km',
    description: 'Easy aerobic run.',
    sportType: { sportTypeId: 1, sportTypeKey: 'running', displayOrder: 1 },
    estimatedDistanceInMeters: 8000,
    workoutSegments: [
      {
        segmentOrder: 1,
        sportType: { sportTypeId: 1, sportTypeKey: 'running', displayOrder: 1 },
        workoutSteps: [
          {
            type: 'ExecutableStepDTO',
            stepId: null,
            stepOrder: 1,
            stepType: { stepTypeId: 3, stepTypeKey: 'interval', displayOrder: 3 },
            childStepId: null,
            description: '8km easy run',
            endCondition: {
              conditionTypeId: 3,
              conditionTypeKey: 'distance',
              displayOrder: 3,
              displayable: true,
            },
            endConditionValue: 8000,
            preferredEndConditionUnit: { unitId: 2, unitKey: 'kilometer', factor: 100000 },
            targetType: {
              workoutTargetTypeId: 1,
              workoutTargetTypeKey: 'no.target',
              displayOrder: 1,
            },
            targetValueOne: null,
            targetValueTwo: null,
          },
        ],
      },
    ],
  };
}

/** Interval workout with warmup, rest, repeat group, cooldown */
function intervalWorkout(): Record<string, unknown> {
  return {
    workoutName: 'Thu Intervals — 6×600m (~8km)',
    description: '6 × 600m at 4:55/km',
    sportType: { sportTypeId: 1, sportTypeKey: 'running', displayOrder: 1 },
    estimatedDistanceInMeters: 8000,
    workoutSegments: [
      {
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
            endCondition: {
              conditionTypeId: 3,
              conditionTypeKey: 'distance',
              displayOrder: 3,
              displayable: true,
            },
            endConditionValue: 2000,
            preferredEndConditionUnit: { unitId: 2, unitKey: 'kilometer', factor: 100000 },
            targetType: {
              workoutTargetTypeId: 1,
              workoutTargetTypeKey: 'no.target',
              displayOrder: 1,
            },
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
            endCondition: {
              conditionTypeId: 2,
              conditionTypeKey: 'time',
              displayOrder: 2,
              displayable: true,
            },
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
                endCondition: {
                  conditionTypeId: 3,
                  conditionTypeKey: 'distance',
                  displayOrder: 3,
                  displayable: true,
                },
                endConditionValue: 600,
                preferredEndConditionUnit: { unitId: 2, unitKey: 'kilometer', factor: 100000 },
                targetType: {
                  workoutTargetTypeId: 6,
                  workoutTargetTypeKey: 'pace.zone',
                  displayOrder: 6,
                },
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
                endCondition: {
                  conditionTypeId: 2,
                  conditionTypeKey: 'time',
                  displayOrder: 2,
                  displayable: true,
                },
                endConditionValue: 90,
                preferredEndConditionUnit: null,
                targetType: null,
                targetValueOne: null,
                targetValueTwo: null,
              },
            ],
            endConditionValue: 6,
            preferredEndConditionUnit: null,
            endCondition: {
              conditionTypeId: 7,
              conditionTypeKey: 'iterations',
              displayOrder: 7,
              displayable: false,
            },
            smartRepeat: false,
          },
          {
            type: 'ExecutableStepDTO',
            stepId: null,
            stepOrder: 6,
            stepType: { stepTypeId: 2, stepTypeKey: 'cooldown', displayOrder: 2 },
            childStepId: null,
            description: 'Easy cooldown jog',
            endCondition: {
              conditionTypeId: 1,
              conditionTypeKey: 'lap.button',
              displayOrder: 1,
              displayable: true,
            },
            endConditionValue: null,
            preferredEndConditionUnit: null,
            targetType: {
              workoutTargetTypeId: 1,
              workoutTargetTypeKey: 'no.target',
              displayOrder: 1,
            },
            targetValueOne: null,
            targetValueTwo: null,
          },
        ],
      },
    ],
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
    const { workoutName: _, ...w } = easyRun();
    const r = validateWorkoutJson(w);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.some((e) => e.includes('workoutName'))).toBe(true);
  });

  it('rejects empty workoutName', () => {
    const w = easyRun();
    w.workoutName = '';
    const r = validateWorkoutJson(w);
    expect(r.ok).toBe(false);
  });

  it('rejects non-running sportType', () => {
    const w = easyRun();
    w.sportType = { sportTypeId: 2, sportTypeKey: 'cycling', displayOrder: 2 };
    const r = validateWorkoutJson(w);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.some((e) => e.includes('running'))).toBe(true);
  });

  it('rejects empty workoutSegments', () => {
    const w = easyRun();
    w.workoutSegments = [];
    const r = validateWorkoutJson(w);
    expect(r.ok).toBe(false);
  });
});

// ─── Step validation ─────────────────────────────────────────────────────────

describe('validateWorkoutJson — step validation', () => {
  it('rejects unknown step type', () => {
    const w = easyRun();
    firstSegment(w).workoutSteps = [
      {
        type: 'UnknownDTO',
        stepOrder: 1,
      },
    ];
    const r = validateWorkoutJson(w);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.some((e) => e.includes('UnknownDTO'))).toBe(true);
  });

  it('rejects invalid stepTypeId', () => {
    const w = easyRun();
    const steps = firstSegmentSteps(w);
    (defined(steps[0]).stepType as Record<string, unknown>).stepTypeId = 99;
    const r = validateWorkoutJson(w);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.some((e) => e.includes('stepTypeId'))).toBe(true);
  });

  it('rejects rest step with non-null targetType', () => {
    const w = intervalWorkout();
    const steps = firstSegmentSteps(w);
    // Step index 1 is the rest step
    defined(steps[1]).targetType = {
      workoutTargetTypeId: 1,
      workoutTargetTypeKey: 'no.target',
      displayOrder: 1,
    };
    const r = validateWorkoutJson(w);
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.error.some((e) => e.includes('rest') && e.includes('targetType'))).toBe(true);
  });

  it('rejects distance step without preferredEndConditionUnit', () => {
    const w = easyRun();
    const steps = firstSegmentSteps(w);
    defined(steps[0]).preferredEndConditionUnit = null;
    const r = validateWorkoutJson(w);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.some((e) => e.includes('kilometer'))).toBe(true);
  });

  it('rejects cooldown with non-null endConditionValue on lap.button', () => {
    const w = intervalWorkout();
    const steps = firstSegmentSteps(w);
    // Last step is cooldown
    defined(steps[3]).endConditionValue = 2000;
    const r = validateWorkoutJson(w);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.some((e) => e.includes('lap.button'))).toBe(true);
  });
});

// ─── Pace target validation ──────────────────────────────────────────────────

describe('validateWorkoutJson — pace targets', () => {
  it('rejects pace.zone with missing targetValues', () => {
    const w = intervalWorkout();
    const steps = firstSegmentSteps(w);
    const repeatGroup = steps[2] as Record<string, unknown>;
    const children = repeatGroup.workoutSteps as Array<Record<string, unknown>>;
    defined(children[0]).targetValueOne = null;
    const r = validateWorkoutJson(w);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.some((e) => e.includes('pace.zone'))).toBe(true);
  });

  it('rejects pace.zone with inverted values (slow > fast)', () => {
    const w = intervalWorkout();
    const steps = firstSegmentSteps(w);
    const repeatGroup = steps[2] as Record<string, unknown>;
    const children = repeatGroup.workoutSteps as Array<Record<string, unknown>>;
    // Swap: targetValueOne should be higher (faster) than targetValueTwo
    const paceStep = defined(children[0]);
    paceStep.targetValueOne = 3.0;
    paceStep.targetValueTwo = 3.5;
    const r = validateWorkoutJson(w);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.some((e) => e.includes('targetValueOne'))).toBe(true);
  });
});

// ─── Repeat group validation ─────────────────────────────────────────────────

describe('validateWorkoutJson — repeat groups', () => {
  it('rejects repeat group with mismatched numberOfIterations and endConditionValue', () => {
    const w = intervalWorkout();
    const steps = firstSegmentSteps(w);
    (steps[2] as Record<string, unknown>).numberOfIterations = 8;
    // endConditionValue is still 6
    const r = validateWorkoutJson(w);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.some((e) => e.includes('numberOfIterations'))).toBe(true);
  });

  it('rejects repeat group with empty workoutSteps', () => {
    const w = intervalWorkout();
    const steps = firstSegmentSteps(w);
    (steps[2] as Record<string, unknown>).workoutSteps = [];
    const r = validateWorkoutJson(w);
    expect(r.ok).toBe(false);
  });

  it('rejects repeat group with mixed childStepIds', () => {
    const w = intervalWorkout();
    const steps = firstSegmentSteps(w);
    const repeatGroup = steps[2] as Record<string, unknown>;
    const children = repeatGroup.workoutSteps as Array<Record<string, unknown>>;
    defined(children[1]).childStepId = 99; // different from children[0] which is 1
    const r = validateWorkoutJson(w);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.some((e) => e.includes('childStepId'))).toBe(true);
  });
});

// ─── Step order validation ───────────────────────────────────────────────────

describe('validateWorkoutJson — step ordering', () => {
  it('rejects non-sequential step orders', () => {
    const w = intervalWorkout();
    const steps = firstSegmentSteps(w);
    // Set cooldown (last step) to stepOrder 3 (same as repeat group)
    defined(steps[3]).stepOrder = 3;
    const r = validateWorkoutJson(w);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.some((e) => e.includes('sequential'))).toBe(true);
  });
});

// ─── Exact issue lists ───────────────────────────────────────────────────────
// Every issue text and its position, for inputs with several faults at once.

const executable = (fields: Record<string, unknown>) => ({ type: 'ExecutableStepDTO', ...fields });
const oneSegment = (steps: readonly unknown[]) => ({
  workoutName: 'W',
  sportType: { sportTypeKey: 'running' },
  workoutSegments: [{ workoutSteps: steps }],
});
const S0 = 'segment[0].step[0]';

describe('validateWorkoutJson — exact issue lists', () => {
  it.each<[string, unknown, readonly string[]]>([
    ['a non-object', 'run', ['Workout JSON must be a non-null object']],
    [
      'an empty object',
      {},
      [
        'workoutName must be a non-empty string',
        'sportType must be an object',
        'workoutSegments must be a non-empty array',
      ],
    ],
    [
      'a cycling workout with stepless segments',
      {
        workoutName: 'W',
        sportType: { sportTypeKey: 'cycling' },
        workoutSegments: [{}, { workoutSteps: [] }],
      },
      [
        'sportType.sportTypeKey must be "running", got "cycling"',
        'Segment 0: workoutSteps must be a non-empty array',
        'Segment 1: workoutSteps must be a non-empty array',
      ],
    ],
    [
      'an executable step wrong in every field',
      oneSegment([
        executable({
          stepOrder: 0,
          stepType: { stepTypeId: 9, stepTypeKey: 'sprint' },
          endCondition: { conditionTypeId: 5, conditionTypeKey: 'lap.button' },
          endConditionValue: 3,
          targetType: { workoutTargetTypeKey: 'pace.zone' },
          targetValueOne: 'x',
          targetValueTwo: 2,
        }),
      ]),
      [
        `${S0}: stepOrder must be a positive number`,
        `${S0}: invalid stepTypeId 9`,
        `${S0}: invalid stepTypeKey "sprint"`,
        `${S0}: invalid conditionTypeId 5`,
        `${S0}: cooldown with lap.button must have endConditionValue: null`,
        `${S0}: pace.zone targets require numeric targetValueOne and targetValueTwo`,
      ],
    ],
    [
      'a rest step with a pace target and a distance without unit',
      oneSegment([
        executable({
          stepOrder: 1,
          stepType: { stepTypeId: 5, stepTypeKey: 'rest' },
          endCondition: { conditionTypeId: 3, conditionTypeKey: 'distance' },
          endConditionValue: 400,
          targetType: { workoutTargetTypeKey: 'pace.zone' },
          targetValueOne: 3.0,
          targetValueTwo: 3.5,
        }),
      ]),
      [
        `${S0}: distance steps must have preferredEndConditionUnit with unitKey "kilometer"`,
        `${S0}: rest steps must have targetType: null`,
        `${S0}: targetValueOne (fast, 3) must be > targetValueTwo (slow, 3.5)`,
      ],
    ],
    [
      'a step missing its type and end condition',
      oneSegment([executable({ stepOrder: 'one' })]),
      [
        `${S0}: stepOrder must be a positive number`,
        `${S0}: stepType is required`,
        `${S0}: endCondition is required`,
      ],
    ],
    [
      'a repeat group wrong in every field',
      oneSegment([
        {
          type: 'RepeatGroupDTO',
          stepOrder: -1,
          stepType: { stepTypeId: 3, stepTypeKey: 'interval' },
          numberOfIterations: 0,
          endCondition: { conditionTypeKey: 'time' },
          endConditionValue: 5,
          workoutSteps: [],
        },
      ]),
      [
        `${S0}: stepOrder must be a positive number`,
        `${S0}: RepeatGroupDTO must have stepType repeat (id=6)`,
        `${S0}: numberOfIterations must be a positive number`,
        `${S0}: RepeatGroupDTO must have endCondition "iterations"`,
        `${S0}: numberOfIterations (0) must match endConditionValue (5)`,
        `${S0}: RepeatGroupDTO must have non-empty workoutSteps`,
      ],
    ],
    [
      'a repeat group with mixed childStepIds, a bad child and a step order regression',
      oneSegment([
        {
          type: 'RepeatGroupDTO',
          stepOrder: 2,
          stepType: { stepTypeId: 6, stepTypeKey: 'repeat' },
          numberOfIterations: 3,
          endCondition: { conditionTypeKey: 'iterations' },
          endConditionValue: 4,
          workoutSteps: [
            executable({
              stepOrder: 2,
              childStepId: 1,
              stepType: { stepTypeId: 3, stepTypeKey: 'interval' },
              endCondition: { conditionTypeId: 2, conditionTypeKey: 'time' },
              endConditionValue: 60,
              targetType: null,
            }),
            { type: 'Bogus', childStepId: 2, stepOrder: 9 },
          ],
        },
        executable({
          stepOrder: 1,
          stepType: { stepTypeId: 2, stepTypeKey: 'cooldown' },
          endCondition: { conditionTypeId: 1, conditionTypeKey: 'lap.button' },
          endConditionValue: null,
          targetType: null,
        }),
      ]),
      [
        `${S0}: numberOfIterations (3) must match endConditionValue (4)`,
        `${S0}: all children must share the same childStepId`,
        `${S0}.step[1]: unknown step type "Bogus"`,
        'Step order not sequential: 2 → 2 in segment[0]',
        'Step order not sequential: 2 → 1 in segment[0]',
      ],
    ],
    [
      'two segments, each with its own order check',
      {
        workoutName: '',
        sportType: null,
        workoutSegments: [
          {
            workoutSteps: [2, 2].map((stepOrder) =>
              executable({
                stepOrder,
                stepType: { stepTypeId: 3, stepTypeKey: 'interval' },
                endCondition: { conditionTypeId: 2 },
                targetType: null,
              }),
            ),
          },
          { workoutSteps: [{ type: 'RepeatGroupDTO' }] },
        ],
      },
      [
        'workoutName must be a non-empty string',
        'sportType must be an object',
        'Step order not sequential: 2 → 2 in segment[0]',
        'segment[1].step[0]: stepOrder must be a positive number',
        'segment[1].step[0]: RepeatGroupDTO must have stepType repeat (id=6)',
        'segment[1].step[0]: numberOfIterations must be a positive number',
        'segment[1].step[0]: RepeatGroupDTO must have endCondition "iterations"',
        'segment[1].step[0]: RepeatGroupDTO must have non-empty workoutSteps',
      ],
    ],
  ])('reports %s', (_name, input, issues) => {
    expect(validateWorkoutJson(input)).toEqual({ ok: false, error: issues });
  });
});

// ─── Parsed steps ────────────────────────────────────────────────────────────

describe('parseWorkoutJson', () => {
  it('parses the interval workout into typed steps', () => {
    const lap: StepEnd = { kind: 'lap.button', conditionTypeId: 1 };
    const km: StepEnd = { kind: 'distance', conditionTypeId: 3 };
    const timed: StepEnd = { kind: 'other', conditionTypeId: 2 };
    expect(parseWorkoutJson(intervalWorkout())).toEqual({
      ok: true,
      value: {
        workoutName: 'Thu Intervals — 6×600m (~8km)',
        segments: [
          [
            {
              kind: 'active',
              stepOrder: 1,
              stepType: { id: 1, key: 'warmup' },
              end: km,
              target: { kind: 'other' },
            },
            { kind: 'rest', stepOrder: 2, stepTypeId: 5, end: timed },
            {
              kind: 'repeat',
              stepOrder: 3,
              iterations: 6,
              steps: [
                {
                  kind: 'active',
                  stepOrder: 4,
                  stepType: { id: 3, key: 'interval' },
                  end: km,
                  target: { kind: 'pace.zone', fast: 3.5087719, slow: 3.2786885 },
                },
                { kind: 'rest', stepOrder: 5, stepTypeId: 5, end: timed },
              ],
            },
            {
              kind: 'active',
              stepOrder: 6,
              stepType: { id: 2, key: 'cooldown' },
              end: lap,
              target: { kind: 'other' },
            },
          ],
        ],
      },
    });
  });

  it('reports the same issues as validateWorkoutJson', () => {
    const w = intervalWorkout();
    defined(firstSegmentSteps(w)[3]).endConditionValue = 2000;
    const parsed = parseWorkoutJson(w);
    const validated = validateWorkoutJson(w);
    expect(parsed.ok || validated.ok).toBe(false);
    if (!parsed.ok && !validated.ok) expect(parsed.error).toEqual(validated.error);
  });

  // ── Round trip: any typed workout, written as Garmin JSON, parses back to itself ──

  const nonEmpty = <T>(items: readonly T[]): NonEmpty<T> => {
    const [head, ...tail] = items;
    if (head === undefined) throw new Error('expected at least one item');
    return [head, ...tail];
  };

  const endArb: fc.Arbitrary<StepEnd> = fc.record({
    kind: fc.constantFrom('lap.button' as const, 'distance' as const, 'other' as const),
    conditionTypeId: fc.constantFrom(1 as const, 2 as const, 3 as const, 7 as const),
  });
  const stepTypeIdArb = fc.constantFrom(1 as const, 2 as const, 3 as const, 4 as const, 5 as const);
  const paceArb = fc
    .tuple(fc.double({ min: 1, max: 8, noNaN: true }), fc.double({ min: 1, max: 8, noNaN: true }))
    .filter(([fast, slow]) => fast > slow)
    .map(([fast, slow]) => ({ kind: 'pace.zone' as const, fast, slow }));
  const targetArb: fc.Arbitrary<StepTarget> = fc.oneof(
    fc.constant({ kind: 'none' as const }),
    fc.constant({ kind: 'other' as const }),
    paceArb,
  );
  // Step orders are placeholders here; `numbered` assigns them in document order.
  const executableArb: fc.Arbitrary<StepSpec> = fc.oneof(
    fc.record({
      kind: fc.constant('rest' as const),
      stepOrder: fc.constant(0),
      stepTypeId: stepTypeIdArb,
      end: endArb,
    }),
    fc.record({
      kind: fc.constant('active' as const),
      stepOrder: fc.constant(0),
      stepType: fc.record({
        id: stepTypeIdArb,
        key: fc.constantFrom(
          'warmup' as const,
          'cooldown' as const,
          'interval' as const,
          'recovery' as const,
        ),
      }),
      end: endArb,
      target: targetArb,
    }),
  );
  const stepArb: fc.Arbitrary<StepSpec> = fc.oneof(
    executableArb,
    fc.record({
      kind: fc.constant('repeat' as const),
      stepOrder: fc.constant(0),
      iterations: fc.integer({ min: 1, max: 20 }),
      steps: fc.array(executableArb, { minLength: 1, maxLength: 4 }).map(nonEmpty),
    }),
  );

  /** Number steps from `first` in document order: a repeat group before its children. */
  function numbered(
    steps: readonly StepSpec[],
    first: number,
  ): { steps: StepSpec[]; next: number } {
    return steps.reduce<{ steps: StepSpec[]; next: number }>(
      ({ steps: done, next }, step) => {
        if (step.kind !== 'repeat')
          return { steps: [...done, { ...step, stepOrder: next }], next: next + 1 };
        const children = numbered(step.steps, next + 1);
        const group: StepSpec = { ...step, stepOrder: next, steps: nonEmpty(children.steps) };
        return { steps: [...done, group], next: children.next };
      },
      { steps: [], next: first },
    );
  }

  const workoutArb: fc.Arbitrary<WorkoutSpec> = fc
    .record({
      workoutName: fc.string({ minLength: 1, maxLength: 30 }),
      segments: fc.array(fc.array(stepArb, { minLength: 1, maxLength: 5 }), {
        minLength: 1,
        maxLength: 3,
      }),
    })
    .map(({ workoutName, segments }) => ({
      workoutName,
      segments: nonEmpty(segments.map((steps) => nonEmpty(numbered(steps, 1).steps))),
    }));

  const endJson = (end: StepEnd) => ({
    endCondition: {
      conditionTypeId: end.conditionTypeId,
      conditionTypeKey: end.kind === 'other' ? 'time' : end.kind,
    },
    endConditionValue: end.kind === 'lap.button' ? null : 600,
    preferredEndConditionUnit: end.kind === 'distance' ? { unitKey: 'kilometer' } : null,
  });

  const targetJson = (target: StepTarget) => {
    switch (target.kind) {
      case 'none':
        return { targetType: null, targetValueOne: null, targetValueTwo: null };
      case 'other':
        return { targetType: { workoutTargetTypeKey: 'no.target' } };
      case 'pace.zone':
        return {
          targetType: { workoutTargetTypeKey: 'pace.zone' },
          targetValueOne: target.fast,
          targetValueTwo: target.slow,
        };
      default:
        return assertNever(target);
    }
  };

  /** The Garmin JSON a typed step stands for. */
  function stepJson(step: StepSpec, childStepId: number | null): Record<string, unknown> {
    switch (step.kind) {
      case 'rest':
        return executable({
          stepOrder: step.stepOrder,
          childStepId,
          stepType: { stepTypeId: step.stepTypeId, stepTypeKey: 'rest' },
          ...endJson(step.end),
          targetType: null,
        });
      case 'active':
        return executable({
          stepOrder: step.stepOrder,
          childStepId,
          stepType: { stepTypeId: step.stepType.id, stepTypeKey: step.stepType.key },
          ...endJson(step.end),
          ...targetJson(step.target),
        });
      case 'repeat':
        return {
          type: 'RepeatGroupDTO',
          stepOrder: step.stepOrder,
          childStepId,
          stepType: { stepTypeId: 6, stepTypeKey: 'repeat' },
          numberOfIterations: step.iterations,
          endCondition: { conditionTypeId: 7, conditionTypeKey: 'iterations' },
          endConditionValue: step.iterations,
          workoutSteps: step.steps.map((child) => stepJson(child, step.stepOrder)),
        };
      default:
        return assertNever(step);
    }
  }

  const workoutJson = (workout: WorkoutSpec) => ({
    workoutName: workout.workoutName,
    sportType: { sportTypeId: 1, sportTypeKey: 'running' },
    workoutSegments: workout.segments.map((steps) => ({
      workoutSteps: steps.map((step) => stepJson(step, null)),
    })),
  });

  it('property: a typed workout written as Garmin JSON parses back to itself', () => {
    fc.assert(
      fc.property(workoutArb, (workout) => {
        expect(parseWorkoutJson(workoutJson(workout))).toEqual({ ok: true, value: workout });
      }),
    );
  });

  it('property: a rest step given any target is rejected, never parsed', () => {
    fc.assert(
      fc.property(executableArb, targetArb, (step, target) => {
        if (step.kind !== 'rest' || target.kind === 'none') return;
        const json = { ...stepJson({ ...step, stepOrder: 1 }, null), ...targetJson(target) };
        const parsed = parseWorkoutJson(oneSegment([json]));
        expect(parsed.ok).toBe(false);
        if (!parsed.ok)
          expect(parsed.error).toContain(`${S0}: rest steps must have targetType: null`);
      }),
    );
  });
});
