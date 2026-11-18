import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isRecord } from './is-record.js';

describe('isRecord', () => {
  it('accepts plain objects, empty ones and objects with any fields', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ type: 'result', session_id: 'abc' })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
  });

  it('accepts class instances such as errors, whose fields are read as unknown', () => {
    expect(isRecord(new Error('boom'))).toBe(true);
  });

  it('rejects null, arrays and every primitive', () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord([{ a: 1 }])).toBe(false);
    expect(isRecord('object')).toBe(false);
    expect(isRecord(0)).toBe(false);
    expect(isRecord(true)).toBe(false);
    expect(isRecord(Symbol('s'))).toBe(false);
    expect(isRecord(() => ({}))).toBe(false);
  });

  it('accepts exactly the JSON values that are objects', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const isJsonObject = typeof value === 'object' && value !== null && !Array.isArray(value);
        expect(isRecord(value)).toBe(isJsonObject);
      }),
    );
  });
});
