// ─── Workout JSON Validation ──────────────────────────────────────────────────
//
// Parses Garmin IWorkoutDetail JSON into a typed workout before submission to the API,
// reporting every issue found rather than the first. Pure — no API calls, no side effects.

import { type UnknownRecord, isRecord } from './is-record.js';
import { type Result, err, ok } from './types.js';

// ─── The parsed workout (the subset of Garmin IWorkoutDetail that is checked) ─

const STEP_TYPE_IDS = [1, 2, 3, 4, 5, 6] as const; // warmup, cooldown, interval, recovery, rest, repeat
const STEP_TYPE_KEYS = ['warmup', 'cooldown', 'interval', 'recovery', 'rest', 'repeat'] as const;
const CONDITION_TYPE_IDS = [1, 2, 3, 7] as const; // lap.button, time, distance, iterations

type StepTypeId = (typeof STEP_TYPE_IDS)[number];
type StepTypeKey = (typeof STEP_TYPE_KEYS)[number];
type ConditionTypeId = (typeof CONDITION_TYPE_IDS)[number];

export type NonEmpty<T> = readonly [T, ...T[]];

/**
 * How an executable step ends. A lap-button end carries no value (`endConditionValue: null`);
 * a distance is set in kilometres; any other condition is not checked further.
 */
export type StepEnd = Readonly<{
  kind: 'lap.button' | 'distance' | 'other';
  conditionTypeId: ConditionTypeId;
}>;

/** What an active step aims for. A pace zone runs from fast to slow, in m/s. */
export type StepTarget =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'pace.zone'; fast: number; slow: number }>
  /** Any other target type (no.target, heart rate, …); its values are not checked. */
  | Readonly<{ kind: 'other' }>;

export type StepSpec =
  /** A rest step has no target: `targetType: null`. */
  | Readonly<{ kind: 'rest'; stepOrder: number; stepTypeId: StepTypeId; end: StepEnd }>
  | Readonly<{
      kind: 'active';
      stepOrder: number;
      stepType: Readonly<{ id: StepTypeId; key: Exclude<StepTypeKey, 'rest'> }>;
      end: StepEnd;
      target: StepTarget;
    }>
  /** Repeats its steps `iterations` times; its end condition is "iterations" of that count. */
  | Readonly<{ kind: 'repeat'; stepOrder: number; iterations: number; steps: NonEmpty<StepSpec> }>;

export type WorkoutSpec = Readonly<{
  workoutName: string;
  segments: NonEmpty<NonEmpty<StepSpec>>;
}>;

// ─── Parsing ─────────────────────────────────────────────────────────────────

/** A parsed value, or every issue found, in document order. */
type Parsed<T> = Result<T, readonly string[]>;

/** One step read: the step orders it holds (its own, then its children's) and the step. */
type StepReading = Readonly<{ stepOrders: readonly number[]; step: Parsed<StepSpec> }>;
type StepsReading = Readonly<{ stepOrders: readonly number[]; steps: Parsed<NonEmpty<StepSpec>> }>;

/** Validate a workout JSON structure. Returns list of issues found. */
export function validateWorkoutJson(json: unknown): Result<void, string[]> {
  const parsed = parseWorkoutJson(json);
  return parsed.ok ? ok(undefined) : err([...parsed.error]);
}

/** Parse a workout JSON structure into a typed workout, or every issue found. */
export function parseWorkoutJson(json: unknown): Parsed<WorkoutSpec> {
  if (typeof json !== 'object' || json === null) {
    return err(['Workout JSON must be a non-null object']);
  }
  const w = fieldsOf(json);
  const name = parseWorkoutName(w.workoutName);
  const sport = parseSportType(w.sportType);
  if (!isNonEmptyList(w.workoutSegments)) {
    return err([...issuesOf(name, sport), 'workoutSegments must be a non-empty array']);
  }
  const segments = collect(mapNonEmpty(w.workoutSegments, parseSegment));
  if (!name.ok || !sport.ok || !segments.ok) return err(issuesOf(name, sport, segments));
  return ok({ workoutName: name.value, segments: segments.value });
}

const parseWorkoutName = (raw: unknown): Parsed<string> =>
  typeof raw !== 'string' || raw.length === 0
    ? err(['workoutName must be a non-empty string'])
    : ok(raw);

function parseSportType(raw: unknown): Parsed<'running'> {
  if (typeof raw !== 'object' || raw === null) return err(['sportType must be an object']);
  const key = fieldsOf(raw).sportTypeKey;
  return key === 'running'
    ? ok(key)
    : err([`sportType.sportTypeKey must be "running", got "${String(key)}"`]);
}

function parseSegment(segment: unknown, si: number): Parsed<NonEmpty<StepSpec>> {
  const steps = fieldsOf(segment).workoutSteps;
  if (!isNonEmptyList(steps)) {
    return err([`Segment ${si}: workoutSteps must be a non-empty array`]);
  }
  const path = `segment[${si}]`;
  const read = readSteps(steps, path);
  const order = orderIssues(read.stepOrders, path);
  return order.length > 0 ? err([...issuesOf(read.steps), ...order]) : read.steps;
}

/** Step orders, read in document order (a repeat group before its children), strictly increase. */
const orderIssues = (stepOrders: readonly number[], path: string): readonly string[] =>
  stepOrders.flatMap((current, i) => {
    const previous = stepOrders[i - 1]; // undefined only for the first step
    return previous !== undefined && current <= previous
      ? [`Step order not sequential: ${previous} → ${current} in ${path}`]
      : [];
  });

function readSteps(steps: NonEmpty<unknown>, path: string): StepsReading {
  const readings = mapNonEmpty(steps, (step, i) => readStep(step, `${path}.step[${i}]`));
  return {
    stepOrders: readings.flatMap((r) => r.stepOrders),
    steps: collect(mapNonEmpty(readings, (r) => r.step)),
  };
}

function readStep(step: unknown, path: string): StepReading {
  const s = fieldsOf(step);
  if (s.type === 'ExecutableStepDTO') return readExecutableStep(s, path);
  if (s.type === 'RepeatGroupDTO') return readRepeatGroup(s, path);
  return { stepOrders: [], step: err([`${path}: unknown step type "${String(s.type)}"`]) };
}

const parseStepOrder = (raw: unknown, path: string): Parsed<number> =>
  typeof raw !== 'number' || raw < 1
    ? err([`${path}: stepOrder must be a positive number`])
    : ok(raw);

const ordersOf = (stepOrder: Parsed<number>): readonly number[] =>
  stepOrder.ok ? [stepOrder.value] : [];

// ─── Executable steps ────────────────────────────────────────────────────────

function readExecutableStep(s: UnknownRecord, path: string): StepReading {
  const stepOrder = parseStepOrder(s.stepOrder, path);
  const stepType = parseStepType(s.stepType, path);
  const end = parseStepEnd(s, path);
  const target = parseStepTarget(s, fieldsOf(s.stepType).stepTypeKey === 'rest', path);
  return {
    stepOrders: ordersOf(stepOrder),
    step:
      stepOrder.ok && stepType.ok && end.ok && target.ok
        ? ok(executableStep(stepOrder.value, stepType.value, end.value, target.value))
        : err(issuesOf(stepOrder, stepType, end, target)),
  };
}

function executableStep(
  stepOrder: number,
  { id, key }: Readonly<{ id: StepTypeId; key: StepTypeKey }>,
  end: StepEnd,
  target: StepTarget,
): StepSpec {
  return key === 'rest'
    ? { kind: 'rest', stepOrder, stepTypeId: id, end }
    : { kind: 'active', stepOrder, stepType: { id, key }, end, target };
}

function parseStepType(
  raw: unknown,
  path: string,
): Parsed<Readonly<{ id: StepTypeId; key: StepTypeKey }>> {
  if (!raw) return err([`${path}: stepType is required`]);
  const { stepTypeId: id, stepTypeKey: key } = fieldsOf(raw);
  if (isStepTypeId(id) && isStepTypeKey(key)) return ok({ id, key });
  return err([
    ...(isStepTypeId(id) ? [] : [`${path}: invalid stepTypeId ${String(id)}`]),
    ...(isStepTypeKey(key) ? [] : [`${path}: invalid stepTypeKey "${String(key)}"`]),
  ]);
}

function parseStepEnd(s: UnknownRecord, path: string): Parsed<StepEnd> {
  if (!s.endCondition) return err([`${path}: endCondition is required`]);
  const { conditionTypeId, conditionTypeKey: key } = fieldsOf(s.endCondition);
  const kind = key === 'lap.button' || key === 'distance' ? key : 'other';
  const issues = [
    ...(isConditionTypeId(conditionTypeId)
      ? []
      : [`${path}: invalid conditionTypeId ${String(conditionTypeId)}`]),
    ...(kind === 'lap.button' && s.endConditionValue !== null
      ? [`${path}: cooldown with lap.button must have endConditionValue: null`]
      : []),
    ...(kind === 'distance' && fieldsOf(s.preferredEndConditionUnit).unitKey !== 'kilometer'
      ? [`${path}: distance steps must have preferredEndConditionUnit with unitKey "kilometer"`]
      : []),
  ];
  return isConditionTypeId(conditionTypeId) && issues.length === 0
    ? ok({ kind, conditionTypeId })
    : err(issues);
}

/** A rest step has no target; any target that is a pace zone needs both values, fast before slow. */
function parseStepTarget(s: UnknownRecord, isRest: boolean, path: string): Parsed<StepTarget> {
  const target = parsePaceTarget(s, path);
  return isRest && s.targetType !== null
    ? err([`${path}: rest steps must have targetType: null`, ...issuesOf(target)])
    : target;
}

function parsePaceTarget(s: UnknownRecord, path: string): Parsed<StepTarget> {
  if (!s.targetType) return ok({ kind: 'none' });
  if (fieldsOf(s.targetType).workoutTargetTypeKey !== 'pace.zone') return ok({ kind: 'other' });
  const { targetValueOne: fast, targetValueTwo: slow } = s;
  if (typeof fast !== 'number' || typeof slow !== 'number') {
    return err([`${path}: pace.zone targets require numeric targetValueOne and targetValueTwo`]);
  }
  // targetValueOne (fast) should be > targetValueTwo (slow) in m/s
  return fast <= slow
    ? err([`${path}: targetValueOne (fast, ${fast}) must be > targetValueTwo (slow, ${slow})`])
    : ok({ kind: 'pace.zone', fast, slow });
}

// ─── Repeat groups ───────────────────────────────────────────────────────────

function readRepeatGroup(s: UnknownRecord, path: string): StepReading {
  const stepOrder = parseStepOrder(s.stepOrder, path);
  const iterations = parseRepeatIterations(s, path);
  const children = s.workoutSteps;
  if (!isNonEmptyList(children)) {
    const empty = `${path}: RepeatGroupDTO must have non-empty workoutSteps`;
    return {
      stepOrders: ordersOf(stepOrder),
      step: err([...issuesOf(stepOrder, iterations), empty]),
    };
  }
  const childIds = new Set(children.map((child) => fieldsOf(child).childStepId));
  const shared = childIds.size > 1 ? [`${path}: all children must share the same childStepId`] : [];
  const read = readSteps(children, path);
  return {
    stepOrders: [...ordersOf(stepOrder), ...read.stepOrders],
    step:
      stepOrder.ok && iterations.ok && shared.length === 0 && read.steps.ok
        ? ok({
            kind: 'repeat',
            stepOrder: stepOrder.value,
            iterations: iterations.value,
            steps: read.steps.value,
          })
        : err([...issuesOf(stepOrder, iterations), ...shared, ...issuesOf(read.steps)]),
  };
}

/** The group's repeat count: a repeat step type, ending on "iterations" of the same count. */
function parseRepeatIterations(s: UnknownRecord, path: string): Parsed<number> {
  const stepType = fieldsOf(s.stepType);
  const iterations = s.numberOfIterations;
  const issues = [
    ...(stepType.stepTypeKey === 'repeat' && stepType.stepTypeId === 6
      ? []
      : [`${path}: RepeatGroupDTO must have stepType repeat (id=6)`]),
    ...(typeof iterations !== 'number' || iterations < 1
      ? [`${path}: numberOfIterations must be a positive number`]
      : []),
    ...(fieldsOf(s.endCondition).conditionTypeKey === 'iterations'
      ? []
      : [`${path}: RepeatGroupDTO must have endCondition "iterations"`]),
    ...(iterations === s.endConditionValue
      ? []
      : [
          `${path}: numberOfIterations (${iterations}) must match endConditionValue (${s.endConditionValue})`,
        ]),
  ];
  return typeof iterations === 'number' && issues.length === 0 ? ok(iterations) : err(issues);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** The readable fields of a value; anything that is not an object has none. */
const fieldsOf = (value: unknown): UnknownRecord => (isRecord(value) ? value : {});

const isNonEmptyList = (value: unknown): value is NonEmpty<unknown> =>
  Array.isArray(value) && value.length > 0;

const isOneOf =
  <T>(options: readonly T[]) =>
  (value: unknown): value is T =>
    options.some((option) => option === value);

const isStepTypeId = isOneOf(STEP_TYPE_IDS);
const isStepTypeKey = isOneOf(STEP_TYPE_KEYS);
const isConditionTypeId = isOneOf(CONDITION_TYPE_IDS);

const mapNonEmpty = <A, B>(
  [head, ...tail]: NonEmpty<A>,
  f: (a: A, i: number) => B,
): NonEmpty<B> => [f(head, 0), ...tail.map((a, i) => f(a, i + 1))];

/** Every issue of the parts, in order. */
const issuesOf = (...parts: readonly Parsed<unknown>[]): readonly string[] =>
  parts.flatMap((part) => (part.ok ? [] : part.error));

/** Every value when all parts parsed, else every issue in order. */
function collect<T>(parts: NonEmpty<Parsed<T>>): Parsed<NonEmpty<T>> {
  const [first, ...rest] = parts;
  const issues = issuesOf(...parts);
  if (!first.ok || issues.length > 0) return err(issues);
  return ok([first.value, ...rest.flatMap((part) => (part.ok ? [part.value] : []))]);
}
