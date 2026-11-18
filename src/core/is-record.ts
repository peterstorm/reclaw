/** An object whose fields are not yet trusted: each must be narrowed before it is used. */
export type UnknownRecord = Readonly<Record<string, unknown>>;

/** Narrow a parsed or thrown value to an object with readable fields; null and arrays are not records. */
export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
