// ─── Topic Slug ────────────────────────────────────────────────────────────────

/**
 * A URL-safe topic slug derived from a research topic string.
 * Use `generateTopicSlug` to construct.
 *
 * FR-044: System MUST generate a URL-safe topic slug from the research topic
 * for use in folder and file names.
 */
export type TopicSlug = string & { readonly __brand: 'TopicSlug' };

const MAX_SLUG_LENGTH = 60;

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
export function generateTopicSlug(topic: string): TopicSlug {
  const slug = topic
    .toLowerCase()
    .replace(/\s+/g, '-')          // spaces to hyphens
    .replace(/[^a-z0-9-]/g, '')    // strip non-alphanumeric except hyphens
    .replace(/-{2,}/g, '-')        // collapse consecutive hyphens
    .replace(/^-+|-+$/g, '')       // trim leading/trailing hyphens
    .slice(0, MAX_SLUG_LENGTH)     // max 60 chars
    .replace(/-+$/g, '');          // trim trailing hyphens after truncation

  return (slug.length > 0 ? slug : 'untitled') as TopicSlug;
}
