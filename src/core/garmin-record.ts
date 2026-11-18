// ─── Garmin records (functional core) ─────────────────────────────────────────
//
// How garmin-daily reads Garmin Connect's JSON: parsed with zod, never cast. Garmin
// omits and nulls fields freely, so every field is optional, and a field of the wrong
// type reads exactly as a missing one: one odd field falls back like an absent one
// instead of failing its whole section. What reading a record as a whole does is what
// reading properties off it always did — a non-object value has no fields, and null or
// undefined where a record must be is a malformed response, thrown for garmin-fetch to
// report in that section's `errors`.

import { z } from 'zod';

/** A field Garmin may omit or null. A value of any other type reads as missing (`undefined`). */
export const field = <T extends z.ZodTypeAny>(type: T) => type.nullish().catch(undefined);

export const num = field(z.number());
export const str = field(z.string());
export const bool = field(z.boolean());
/** A list field; give its elements lenient schemas too, so one odd element cannot fail the list. */
export const listOf = <T extends z.ZodTypeAny>(element: T) => field(z.array(element));
/** A list whose elements are read one at a time, with {@link readRecord}, where they are used. */
export const list = listOf(z.unknown());
/** A record nested in another, read like a field: one that is not an object is missing. */
export const nested = <S extends z.ZodRawShape>(shape: S) => field(z.object(shape));
/** A record keyed by ids Garmin assigns (a device id, say), each value read where it is used. */
export const keyed = field(z.record(z.unknown()));

const isObject = (raw: unknown): raw is object =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw);

/**
 * One record: an object's fields read by `schema`; any other value has none. Null or
 * undefined is no record at all — a malformed response — and throws.
 */
export function readRecord<S extends z.ZodRawShape>(
  schema: z.ZodObject<S>,
  raw: unknown,
  what: string,
): z.output<z.ZodObject<S>> {
  if (raw === null || raw === undefined) throw new Error(`malformed Garmin ${what}: ${raw}`);
  return schema.parse(isObject(raw) ? raw : {});
}

/** A response that must be a list; anything else is malformed and throws. */
export function readList(raw: unknown, what: string): readonly unknown[] {
  const parsed = z.array(z.unknown()).safeParse(raw);
  if (!parsed.success) throw new Error(`malformed Garmin ${what}: not a list`);
  return parsed.data;
}
