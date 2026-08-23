// ─── Topic Slug ────────────────────────────────────────────────────────────────

import { type Result, err, ok } from './types.js';

/**
 * A URL-safe topic slug derived from a research topic string.
 * Use `generateTopicSlug` to construct.
 *
 * FR-044: System MUST generate a URL-safe topic slug from the research topic
 * for use in folder and file names.
 */
export type TopicSlug = string & { readonly __brand: 'TopicSlug' };

const MAX_SLUG_LENGTH = 60;
const TOPIC_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

/**
 * Generate a URL-safe slug from a research topic string.
 *
 * Rules (FR-044):
 * - Convert to lowercase
 * - Replace spaces with hyphens
 * - Strip non-alphanumeric characters (except hyphens)
 * - Collapse consecutive hyphens into a single hyphen
 * - Trim leading/trailing hyphens
 * - Truncate to 60 characters (trimming trailing hyphens after truncation)
 *
 * If the input is empty or produces an empty slug after processing,
 * the function returns 'untitled' as the slug.
 */
/**
 * Parse a generated topic slug or its canonical vault reference form.
 * Arbitrary nested paths are deliberately not accepted by /ask.
 */
export function parseTopicSlugReference(raw: string): Result<TopicSlug, string> {
  const normalized = raw.trim().replaceAll('\\', '/');
  if (normalized.length === 0) return err('Topic slug must not be empty.');
  if (normalized.startsWith('/')) return err('Topic slug must not be an absolute path.');

  const withoutIndex = normalized.replace(/\/_index(?:\.md)?$/, '');
  const slug = withoutIndex.startsWith('reclaw/research/')
    ? withoutIndex.slice('reclaw/research/'.length)
    : withoutIndex;

  if (slug.includes('/')) return err('Topic slug must identify exactly one research topic.');
  if (slug.length > MAX_SLUG_LENGTH || slug.includes('--') || !TOPIC_SLUG_PATTERN.test(slug)) {
    return err('Topic slug must contain only lowercase letters, numbers, and single hyphens.');
  }
  return ok(slug as TopicSlug);
}

export function generateTopicSlug(topic: string): TopicSlug {
  const slug = topic
    .toLowerCase()
    .replace(/\s+/g, '-') // spaces to hyphens
    .replace(/[^a-z0-9-]/g, '') // strip non-alphanumeric except hyphens
    .replace(/-{2,}/g, '-') // collapse consecutive hyphens
    .replace(/^-+|-+$/g, '') // trim leading/trailing hyphens
    .slice(0, MAX_SLUG_LENGTH) // max 60 chars
    .replace(/-+$/g, ''); // trim trailing hyphens after truncation

  return (slug.length > 0 ? slug : 'untitled') as TopicSlug;
}
