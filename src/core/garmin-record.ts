// ─── Garmin records (functional core) ─────────────────────────────────────────
//
// How garmin-daily reads Garmin Connect's JSON: parsed with zod, never cast. Garmin
// omits and nulls fields freely, so every field is optional, and a field of the wrong
// type reads exactly as a missing one: one odd field falls back like an absent one
// instead of failing its whole section. What reading a record as a whole does is what
// reading properties off it always did — a non-object value has no fields, and null or
// undefined where a record must be is a malformed response, thrown for garmin-fetch to
// report in that section's `errors`.
//
// A wrongly typed field is not lost without trace: every read returns, beside its
// value, the drift it met — the path of each field it read as missing because Garmin
// sent another type — for garmin-fetch to warn about on stderr. Drift never changes
// the value: the daily JSON is the same whether a field is absent or drifted.

import { z } from 'zod';
import { isRecord } from './is-record.js';

/** A field Garmin may omit or null. A value of any other type reads as missing (`undefined`). */
export const field = <T extends z.ZodTypeAny>(type: T) => type.nullish().catch(undefined);

export const num = field(z.number());
export const str = field(z.string());
export const bool = field(z.boolean());
/** A list field; give its elements lenient schemas too, so one odd element cannot fail the list. */
export const listOf = <T extends z.ZodTypeAny>(element: T) => field(z.array(element));
/** A list whose elements are read one at a time, with a {@link RecordReader}, where they are used. */
export const list = listOf(z.unknown());
/** A record nested in another, read like a field: one that is not an object is missing. */
export const nested = <S extends z.ZodRawShape>(shape: S) => field(z.object(shape));
/** A record keyed by ids Garmin assigns (a device id, say), each value read where it is used. */
export const keyed = field(z.record(z.unknown()));

/**
 * A value read from Garmin, with its drift: the path of every field read as missing
 * because Garmin sent a value of another type (`lap.averageHR`, `metrics row.metrics[]`),
 * each once, in the order first met.
 */
export type Read<T> = { readonly value: T; readonly drift: readonly string[] };

/** The drift of all `reads` together, each path once. */
export const driftOf = (...reads: readonly Read<unknown>[]): readonly string[] => [
  ...new Set(reads.flatMap((read) => read.drift)),
];

const isList = (value: unknown): value is readonly unknown[] => Array.isArray(value);

/**
 * Where `parsed` lost a value `raw` held — a field of the wrong type — by path under
 * `path`. A field parses to `undefined` only when it was absent or of the wrong type,
 * and unread values (an unknown list element, a keyed record's entry) parse to the
 * very value sent, so the walk stops at them.
 */
const lostFields = (raw: unknown, parsed: unknown, path: string): readonly string[] => {
  if (parsed === raw) return [];
  if (parsed === undefined) return raw === undefined ? [] : [path];
  if (isList(parsed) && isList(raw)) {
    return parsed.flatMap((element, i) => lostFields(raw[i], element, `${path}[]`));
  }
  if (isRecord(parsed) && isRecord(raw)) {
    return Object.keys(parsed).flatMap((key) =>
      lostFields(raw[key], parsed[key], `${path}.${key}`),
    );
  }
  return [];
};

/**
 * One record: an object's fields read by `schema`; any other value has none, and is
 * no drift (Garmin answers "" for a day with no data). Null or undefined is no record
 * at all — a malformed response — and throws.
 */
export function readRecord<S extends z.ZodRawShape>(
  schema: z.ZodObject<S>,
  raw: unknown,
  what: string,
): Read<z.output<z.ZodObject<S>>> {
  if (raw === null || raw === undefined) throw new Error(`malformed Garmin ${what}: ${raw}`);
  if (!isRecord(raw)) return { value: schema.parse({}), drift: [] };
  const value = schema.parse(raw);
  return { value, drift: [...new Set(lostFields(raw, value, what))] };
}

/** Reads one record of a response, as {@link readRecord} does, keeping its drift for {@link reading}. */
export type RecordReader = <S extends z.ZodRawShape>(
  schema: z.ZodObject<S>,
  raw: unknown,
  what: string,
) => z.output<z.ZodObject<S>>;

/**
 * Reads a whole response with `read`, which reads each of its records with the
 * {@link RecordReader} it is given; the result carries the drift of every record read.
 * `read` must return a finished value, not a lazy one still reading records.
 */
export function reading<T>(read: (record: RecordReader) => T): Read<T> {
  // Local to this call, so `reading` stays pure: the same response gives the same Read.
  const drift = new Set<string>();
  const record: RecordReader = (schema, raw, what) => {
    const parsed = readRecord(schema, raw, what);
    for (const path of parsed.drift) drift.add(path);
    return parsed.value;
  };
  const value = read(record);
  return { value, drift: [...drift] };
}

/** A response that must be a list; anything else is malformed and throws. */
export function readList(raw: unknown, what: string): readonly unknown[] {
  const parsed = z.array(z.unknown()).safeParse(raw);
  if (!parsed.success) throw new Error(`malformed Garmin ${what}: not a list`);
  return parsed.data;
}
