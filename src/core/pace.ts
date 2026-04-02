// ─── Pace Conversion Utilities ────────────────────────────────────────────────
//
// Pure functions for pace ↔ m/s conversion, zone derivation from 5K pace,
// and VDOT-based 5K estimation. Used by the running-coach skill.

/** Pace expressed as min:sec per km */
export interface Pace {
  readonly minutes: number;
  readonly seconds: number;
}

/** A pace target range for Garmin workout JSON (in m/s) */
export interface PaceTarget {
  readonly targetValueOne: number; // faster end (higher m/s)
  readonly targetValueTwo: number; // slower end (lower m/s)
}

/** Training zones derived from estimated 5K race pace */
export interface ZoneTable {
  readonly recovery: { readonly min: Pace; readonly max: Pace };
  readonly easy: { readonly min: Pace; readonly max: Pace };
  readonly steady: { readonly min: Pace; readonly max: Pace };
  readonly tempo: { readonly min: Pace; readonly max: Pace };
  readonly interval: { readonly min: Pace; readonly max: Pace };
  readonly repetition: { readonly min: Pace; readonly max: Pace };
}

// ─── Pace ↔ m/s ──────────────────────────────────────────────────────────────

/** Convert pace (min:sec per km) to speed in m/s */
export function paceToMs(minutes: number, seconds: number): number {
  const totalSeconds = minutes * 60 + seconds;
  if (totalSeconds <= 0) return 0;
  return 1000 / totalSeconds;
}

/** Convert speed in m/s to pace (min:sec per km) */
export function msToPace(ms: number): Pace {
  if (ms <= 0) return { minutes: 0, seconds: 0 };
  const totalSeconds = Math.round(1000 / ms);
  return { minutes: Math.floor(totalSeconds / 60), seconds: totalSeconds % 60 };
}

/** Convert a Pace to total seconds per km */
export function paceToSeconds(pace: Pace): number {
  return pace.minutes * 60 + pace.seconds;
}

// ─── Pace Range ──────────────────────────────────────────────────────────────

/**
 * Build a Garmin pace target range: target ± margin (in seconds/km).
 * targetValueOne = faster (higher m/s), targetValueTwo = slower (lower m/s).
 */
export function paceRange(
  targetMinutes: number,
  targetSeconds: number,
  marginSeconds: number = 10,
): PaceTarget {
  const center = targetMinutes * 60 + targetSeconds;
  const fast = center - marginSeconds; // faster = fewer seconds = higher m/s
  const slow = center + marginSeconds;
  return {
    targetValueOne: 1000 / fast,
    targetValueTwo: 1000 / slow,
  };
}

// ─── Zone Derivation ─────────────────────────────────────────────────────────

/**
 * Add seconds to a pace.
 * Positive offset = slower pace, negative = faster.
 */
function addSeconds(pace: Pace, offsetSeconds: number): Pace {
  const total = pace.minutes * 60 + pace.seconds + offsetSeconds;
  return { minutes: Math.floor(total / 60), seconds: total % 60 };
}

/**
 * Derive all training zones from estimated 5K race pace.
 *
 * Zone formulas (offset from race pace P):
 * - Recovery:   P + 90 to P + 110 s/km
 * - Easy:       P + 60 to P + 90 s/km
 * - Steady:     P + 40 to P + 60 s/km
 * - Tempo:      P + 5  to P + 20 s/km
 * - Interval:   P - 5  to P + 5  s/km
 * - Repetition: P - 30 to P - 10 s/km
 *
 * min = faster end (lower s/km), max = slower end (higher s/km)
 */
export function deriveZones(fiveKPace: Pace): ZoneTable {
  return {
    recovery:   { min: addSeconds(fiveKPace, 90),  max: addSeconds(fiveKPace, 110) },
    easy:       { min: addSeconds(fiveKPace, 60),  max: addSeconds(fiveKPace, 90) },
    steady:     { min: addSeconds(fiveKPace, 40),  max: addSeconds(fiveKPace, 60) },
    tempo:      { min: addSeconds(fiveKPace, 5),   max: addSeconds(fiveKPace, 20) },
    interval:   { min: addSeconds(fiveKPace, -5),  max: addSeconds(fiveKPace, 5) },
    repetition: { min: addSeconds(fiveKPace, -30), max: addSeconds(fiveKPace, -10) },
  };
}

// ─── VDOT Lookup ─────────────────────────────────────────────────────────────

/**
 * Jack Daniels VDOT table: VO2Max → estimated 5K time in seconds.
 * Values for the range typically seen in recreational-to-competitive runners.
 */
const VDOT_TABLE: ReadonlyArray<{ readonly vo2max: number; readonly fiveKSeconds: number }> = [
  { vo2max: 40, fiveKSeconds: 1770 }, // 29:30
  { vo2max: 41, fiveKSeconds: 1722 }, // 28:42
  { vo2max: 42, fiveKSeconds: 1674 }, // 27:54
  { vo2max: 43, fiveKSeconds: 1632 }, // 27:12
  { vo2max: 44, fiveKSeconds: 1590 }, // 26:30
  { vo2max: 45, fiveKSeconds: 1548 }, // 25:48
  { vo2max: 46, fiveKSeconds: 1452 }, // 24:12
  { vo2max: 47, fiveKSeconds: 1416 }, // 23:36
  { vo2max: 48, fiveKSeconds: 1380 }, // 23:00
  { vo2max: 49, fiveKSeconds: 1344 }, // 22:24
  { vo2max: 50, fiveKSeconds: 1314 }, // 21:54
  { vo2max: 52, fiveKSeconds: 1254 }, // 20:54
  { vo2max: 55, fiveKSeconds: 1170 }, // 19:30
  { vo2max: 58, fiveKSeconds: 1098 }, // 18:18
  { vo2max: 60, fiveKSeconds: 1056 }, // 17:36
];

/**
 * Estimate 5K time from Garmin VO2Max using Jack Daniels VDOT interpolation.
 * Returns estimated 5K pace (per km).
 */
export function estimateFromVo2Max(vo2max: number): Pace | null {
  if (vo2max < VDOT_TABLE[0]!.vo2max || vo2max > VDOT_TABLE[VDOT_TABLE.length - 1]!.vo2max) {
    return null; // out of table range
  }

  // Find surrounding entries for interpolation
  let lower = VDOT_TABLE[0]!;
  let upper = VDOT_TABLE[VDOT_TABLE.length - 1]!;

  for (let i = 0; i < VDOT_TABLE.length - 1; i++) {
    if (vo2max >= VDOT_TABLE[i]!.vo2max && vo2max <= VDOT_TABLE[i + 1]!.vo2max) {
      lower = VDOT_TABLE[i]!;
      upper = VDOT_TABLE[i + 1]!;
      break;
    }
  }

  // Linear interpolation
  const ratio = (vo2max - lower.vo2max) / (upper.vo2max - lower.vo2max);
  const fiveKSeconds = Math.round(lower.fiveKSeconds + ratio * (upper.fiveKSeconds - lower.fiveKSeconds));
  const paceSeconds = Math.round(fiveKSeconds / 5);

  return { minutes: Math.floor(paceSeconds / 60), seconds: paceSeconds % 60 };
}
