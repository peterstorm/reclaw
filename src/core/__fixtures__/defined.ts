/**
 * Test-only narrowing in place of the `!` non-null assertion: a missing value
 * fails the test at the read, with a message naming what was expected,
 * instead of surfacing later as an unrelated TypeError.
 */
export const defined = <T>(value: T | null | undefined, what = 'value'): T => {
  if (value === undefined || value === null) {
    throw new Error(`expected ${what} to be present, got ${String(value)}`);
  }
  return value;
};
