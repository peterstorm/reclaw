import {
  type ActivityId,
  type ActivityResult,
  type ActivityResultRepository,
  parseActivityResult,
  serializeActivityResult,
} from '../core/activity.js';

const ACTIVITY_RETENTION_SECONDS = 30 * 24 * 60 * 60;

export type ActivityRedisClient = {
  readonly get: (key: string) => Promise<string | null>;
  readonly set: (
    key: string,
    value: string,
    options: { readonly EX: number; readonly NX: true },
  ) => Promise<string | null>;
};

export function makeActivityResultKey(id: ActivityId): string {
  return `reclaw:activity:v1:${id}`;
}

/**
 * Redis adapter for immutable activity results. SET NX elects one canonical
 * result if a stalled BullMQ job is ever processed concurrently.
 */
export function createActivityResultRepository(
  redis: ActivityRedisClient,
): ActivityResultRepository {
  const find = async (id: ActivityId): Promise<ActivityResult | null> => {
    const raw = await redis.get(makeActivityResultKey(id));
    if (raw === null) return null;
    const parsed = parseActivityResult(raw);
    if (!parsed.ok) {
      throw new Error(`Corrupt persisted activity ${id}: ${parsed.error}`);
    }
    if (parsed.value.id !== id) {
      throw new Error(`Persisted activity identity mismatch for ${id}`);
    }
    return parsed.value;
  };

  const saveIfAbsent = async (result: ActivityResult): Promise<ActivityResult> => {
    const saved = await redis.set(
      makeActivityResultKey(result.id),
      serializeActivityResult(result),
      { EX: ACTIVITY_RETENTION_SECONDS, NX: true },
    );
    if (saved === 'OK') return result;

    const canonical = await find(result.id);
    if (canonical === null) {
      throw new Error(`Activity ${result.id} lost after SET NX conflict`);
    }
    return canonical;
  };

  return { find, saveIfAbsent };
}

export { ACTIVITY_RETENTION_SECONDS };
