import { describe, expect, it } from 'vitest';
import {
  paceToMs,
  msToPace,
  paceToSeconds,
  paceRange,
  deriveZones,
  estimateFromVo2Max,
} from './pace.js';

// ─── paceToMs ────────────────────────────────────────────────────────────────

describe('paceToMs', () => {
  it('converts 5:00/km to 3.3333 m/s', () => {
    expect(paceToMs(5, 0)).toBeCloseTo(3.3333, 3);
  });

  it('converts 4:50/km to 3.4483 m/s', () => {
    expect(paceToMs(4, 50)).toBeCloseTo(3.4483, 3);
  });

  it('converts 6:00/km to 2.7778 m/s', () => {
    expect(paceToMs(6, 0)).toBeCloseTo(2.7778, 3);
  });

  it('converts 4:00/km to 4.1667 m/s', () => {
    expect(paceToMs(4, 0)).toBeCloseTo(4.1667, 3);
  });

  it('returns 0 for zero pace', () => {
    expect(paceToMs(0, 0)).toBe(0);
  });

  it('handles seconds-only pace (e.g. 0:45/km)', () => {
    expect(paceToMs(0, 45)).toBeCloseTo(22.2222, 3);
  });
});

// ─── msToPace ────────────────────────────────────────────────────────────────

describe('msToPace', () => {
  it('converts 3.3333 m/s back to 5:00/km', () => {
    const p = msToPace(3.3333);
    expect(p.minutes).toBe(5);
    expect(p.seconds).toBe(0);
  });

  it('converts 3.4483 m/s back to ~4:50/km', () => {
    const p = msToPace(3.4483);
    expect(p.minutes).toBe(4);
    expect(p.seconds).toBeGreaterThanOrEqual(49);
    expect(p.seconds).toBeLessThanOrEqual(51);
  });

  it('converts 2.7778 m/s back to 6:00/km', () => {
    const p = msToPace(2.7778);
    expect(p.minutes).toBe(6);
    expect(p.seconds).toBe(0);
  });

  it('returns 0:0 for zero speed', () => {
    const p = msToPace(0);
    expect(p.minutes).toBe(0);
    expect(p.seconds).toBe(0);
  });

  it('returns 0:0 for negative speed', () => {
    const p = msToPace(-1);
    expect(p.minutes).toBe(0);
    expect(p.seconds).toBe(0);
  });
});

// ─── Roundtrip ───────────────────────────────────────────────────────────────

describe('pace ↔ m/s roundtrip', () => {
  const cases = [
    { min: 4, sec: 0 },
    { min: 4, sec: 30 },
    { min: 4, sec: 50 },
    { min: 5, sec: 0 },
    { min: 5, sec: 15 },
    { min: 5, sec: 30 },
    { min: 6, sec: 0 },
    { min: 6, sec: 30 },
    { min: 7, sec: 0 },
  ];

  for (const { min, sec } of cases) {
    it(`roundtrips ${min}:${sec.toString().padStart(2, '0')}/km`, () => {
      const ms = paceToMs(min, sec);
      const back = msToPace(ms);
      expect(back.minutes).toBe(min);
      expect(back.seconds).toBe(sec);
    });
  }
});

// ─── paceToSeconds ───────────────────────────────────────────────────────────

describe('paceToSeconds', () => {
  it('converts 5:00 to 300', () => {
    expect(paceToSeconds({ minutes: 5, seconds: 0 })).toBe(300);
  });

  it('converts 4:50 to 290', () => {
    expect(paceToSeconds({ minutes: 4, seconds: 50 })).toBe(290);
  });
});

// ─── paceRange ───────────────────────────────────────────────────────────────

describe('paceRange', () => {
  it('builds ±10s range around 5:00/km', () => {
    const r = paceRange(5, 0);
    // fast = 4:50 = 290s → 1000/290 = 3.4483
    // slow = 5:10 = 310s → 1000/310 = 3.2258
    expect(r.targetValueOne).toBeCloseTo(3.4483, 3);
    expect(r.targetValueTwo).toBeCloseTo(3.2258, 3);
  });

  it('fast is always higher m/s than slow', () => {
    const r = paceRange(4, 55);
    expect(r.targetValueOne).toBeGreaterThan(r.targetValueTwo);
  });

  it('uses custom margin', () => {
    const r = paceRange(5, 0, 15);
    // fast = 4:45 = 285s → 1000/285 = 3.5088
    // slow = 5:15 = 315s → 1000/315 = 3.1746
    expect(r.targetValueOne).toBeCloseTo(3.5088, 3);
    expect(r.targetValueTwo).toBeCloseTo(3.1746, 3);
  });

  it('matches Runna pace encoding for 4:55/km ± 10s', () => {
    const r = paceRange(4, 55);
    // Runna Set 1: targetValueOne: 3.5087719, targetValueTwo: 3.2786885
    // fast = 4:45 = 285s → 1000/285 = 3.50877
    // slow = 5:05 = 305s → 1000/305 = 3.27869
    expect(r.targetValueOne).toBeCloseTo(3.5088, 3);
    expect(r.targetValueTwo).toBeCloseTo(3.2787, 3);
  });
});

// ─── deriveZones ─────────────────────────────────────────────────────────────

describe('deriveZones', () => {
  // With P = 4:50/km (24:10 5K)
  const zones = deriveZones({ minutes: 4, seconds: 50 });

  it('recovery is P + 90 to P + 110', () => {
    expect(paceToSeconds(zones.recovery.min)).toBe(290 + 90);  // 6:20
    expect(paceToSeconds(zones.recovery.max)).toBe(290 + 110); // 6:40
  });

  it('easy is P + 60 to P + 90', () => {
    expect(paceToSeconds(zones.easy.min)).toBe(290 + 60);  // 5:50
    expect(paceToSeconds(zones.easy.max)).toBe(290 + 90);  // 6:20
  });

  it('steady is P + 40 to P + 60', () => {
    expect(paceToSeconds(zones.steady.min)).toBe(290 + 40); // 5:30
    expect(paceToSeconds(zones.steady.max)).toBe(290 + 60); // 5:50
  });

  it('tempo is P + 5 to P + 20', () => {
    expect(paceToSeconds(zones.tempo.min)).toBe(290 + 5);   // 4:55
    expect(paceToSeconds(zones.tempo.max)).toBe(290 + 20);  // 5:10
  });

  it('interval is P - 5 to P + 5', () => {
    expect(paceToSeconds(zones.interval.min)).toBe(290 - 5); // 4:45
    expect(paceToSeconds(zones.interval.max)).toBe(290 + 5); // 4:55
  });

  it('repetition is P - 30 to P - 10', () => {
    expect(paceToSeconds(zones.repetition.min)).toBe(290 - 30); // 4:20
    expect(paceToSeconds(zones.repetition.max)).toBe(290 - 10); // 4:40
  });

  it('zones are ordered from fastest to slowest', () => {
    const zoneOrder = [
      zones.repetition, zones.interval, zones.tempo,
      zones.steady, zones.easy, zones.recovery,
    ];
    for (let i = 0; i < zoneOrder.length - 1; i++) {
      expect(paceToSeconds(zoneOrder[i]!.max)).toBeLessThanOrEqual(
        paceToSeconds(zoneOrder[i + 1]!.min),
      );
    }
  });

  it('works with a slower 5K pace (5:30/km)', () => {
    const slower = deriveZones({ minutes: 5, seconds: 30 });
    // Easy should be 5:30 + 60 to 5:30 + 90 = 6:30 to 7:00
    expect(zones.easy.min.minutes).toBeLessThan(slower.easy.min.minutes);
  });
});

// ─── estimateFromVo2Max ──────────────────────────────────────────────────────

describe('estimateFromVo2Max', () => {
  it('VO2Max 46 gives ~4:50/km (24:10 5K)', () => {
    const pace = estimateFromVo2Max(46);
    expect(pace).not.toBeNull();
    const seconds = pace!.minutes * 60 + pace!.seconds;
    // 24:12 / 5 = 290s = 4:50/km
    expect(seconds).toBeGreaterThanOrEqual(285);
    expect(seconds).toBeLessThanOrEqual(295);
  });

  it('VO2Max 50 is faster than VO2Max 46', () => {
    const p46 = estimateFromVo2Max(46)!;
    const p50 = estimateFromVo2Max(50)!;
    expect(paceToSeconds(p50)).toBeLessThan(paceToSeconds(p46));
  });

  it('VO2Max 40 gives ~5:54/km (29:30 5K)', () => {
    const pace = estimateFromVo2Max(40)!;
    const seconds = paceToSeconds(pace);
    // 29:30 / 5 = 354s = 5:54
    expect(seconds).toBeGreaterThanOrEqual(350);
    expect(seconds).toBeLessThanOrEqual(358);
  });

  it('returns null for VO2Max below table range', () => {
    expect(estimateFromVo2Max(35)).toBeNull();
  });

  it('returns null for VO2Max above table range', () => {
    expect(estimateFromVo2Max(65)).toBeNull();
  });

  it('interpolates between table entries', () => {
    const p45 = estimateFromVo2Max(45)!;
    const p46 = estimateFromVo2Max(46)!;
    const p455 = estimateFromVo2Max(45.5)!;
    // 45.5 should be between 45 and 46
    expect(paceToSeconds(p455)).toBeLessThan(paceToSeconds(p45));
    expect(paceToSeconds(p455)).toBeGreaterThan(paceToSeconds(p46));
  });
});
