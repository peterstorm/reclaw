import { z } from 'zod';
import { InstagramUsername, ShortCode } from './instagram-target.js';
import { type Result, err, ok } from './types.js';

// ─── Domain ───────────────────────────────────────────────────────────────────

/**
 * What a post shows. Signed CDN URLs expire within ~2 days, so media must be fetched in the
 * same run as the scrape. The scraper exposes a carousel's images but not its videos, so a
 * post without a top-level video is read as `images`.
 */
export type PostMedia =
  | {
      readonly kind: 'video';
      readonly videoUrl: string;
      readonly audioUrl: string | null;
      readonly durationSeconds: number | null;
    }
  /** A photo, or each image of a carousel in post order. */
  | { readonly kind: 'images'; readonly imageUrls: readonly [string, ...string[]] }
  | { readonly kind: 'no-media' };

export type InstagramPost = Readonly<{
  shortCode: ShortCode;
  url: string;
  owner: InstagramUsername;
  caption: string;
  /**
   * The post's alt text minus Instagram's `Photo by X on <date>.` boilerplate: either the
   * author's own, or Instagram's automatic `May be an image of … text that says '…'`.
   * Null when nothing is left.
   */
  altText: string | null;
  /** ISO-8601 instant the post was published. */
  postedAt: string;
  hashtags: readonly string[];
  likes: number | null;
  comments: number | null;
  media: PostMedia;
}>;

export type RejectedItem = Readonly<{ index: number; reason: string }>;

export type PartitionedPosts = Readonly<{
  posts: readonly InstagramPost[];
  rejected: readonly RejectedItem[];
}>;

// ─── Wire schema (Apify `apify/instagram-scraper` dataset item) ───────────────

/** Instagram reports hidden counts as -1; negative counts mean "unknown". */
const count = z
  .number()
  .nullish()
  .transform((n) => (n === null || n === undefined || n < 0 ? null : n));

const nonEmptyUrl = z
  .string()
  .nullish()
  .transform((s) => (s === null || s === undefined || s.length === 0 ? null : s));

const ItemSchema = z.object({
  shortCode: z.string(),
  url: z.string().nullish(),
  ownerUsername: z.string(),
  caption: z.string().nullish(),
  timestamp: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'unparseable timestamp'),
  hashtags: z.array(z.string()).nullish(),
  likesCount: count,
  commentsCount: count,
  videoUrl: nonEmptyUrl,
  audioUrl: nonEmptyUrl,
  videoDuration: z.number().positive().nullish(),
  alt: z.string().nullish(),
  /** Photo: the image. Video: its cover. */
  displayUrl: nonEmptyUrl,
  /** Carousel images in order (may repeat one). */
  images: z.array(z.string()).nullish(),
});

type Item = z.infer<typeof ItemSchema>;

/** Instagram's alt boilerplate: `Photo by Jane Doe on March 30, 2026.` / `Video shared by …`. */
const ALT_BOILERPLATE = /^(?:Photo|Video)\b[^.]*? on [A-Z][a-z]+ \d{1,2}, \d{4}\.\s*/;

/** The informative part of a post's alt text, or null when it is only boilerplate. */
export function parseAltText(alt: string | null | undefined): string | null {
  const text = (alt ?? '').replace(ALT_BOILERPLATE, '').replace(/\s+/g, ' ').trim();
  return text.length === 0 ? null : text;
}

const mediaOf = (item: Item): PostMedia => {
  if (item.videoUrl !== null) {
    return {
      kind: 'video',
      videoUrl: item.videoUrl,
      audioUrl: item.audioUrl,
      durationSeconds: item.videoDuration ?? null,
    };
  }
  const carousel = (item.images ?? []).filter((url) => url.length > 0);
  const urls = carousel.length > 0 ? carousel : item.displayUrl === null ? [] : [item.displayUrl];
  const [first, ...rest] = [...new Set(urls)];
  return first === undefined
    ? { kind: 'no-media' }
    : { kind: 'images', imageUrls: [first, ...rest] };
};

/** The scraper reports per-URL failures as `{ error, errorDescription }` dataset rows. */
const ScraperErrorSchema = z.object({
  error: z.string(),
  errorDescription: z.string().nullish(),
});

// ─── Parser ───────────────────────────────────────────────────────────────────

/** Parse one raw dataset item into a post — never throws, never returns a half-valid post. */
export function parseInstagramPost(raw: unknown): Result<InstagramPost, string> {
  const failure = ScraperErrorSchema.safeParse(raw);
  if (failure.success) {
    const detail = failure.data.errorDescription ? `: ${failure.data.errorDescription}` : '';
    return err(`scraper reported ${failure.data.error}${detail}`);
  }

  const parsed = ItemSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return err(`unexpected item shape (${issue?.path.join('.') ?? '?'}: ${issue?.message ?? '?'})`);
  }
  const item = parsed.data;

  const shortCode = ShortCode(item.shortCode);
  if (!shortCode.ok) return shortCode;
  const owner = InstagramUsername(item.ownerUsername);
  if (!owner.ok) return owner;

  return ok({
    shortCode: shortCode.value,
    url: item.url ?? `https://www.instagram.com/p/${shortCode.value}/`,
    owner: owner.value,
    caption: item.caption ?? '',
    altText: parseAltText(item.alt),
    postedAt: new Date(item.timestamp).toISOString(),
    hashtags: item.hashtags ?? [],
    likes: item.likesCount,
    comments: item.commentsCount,
    media: mediaOf(item),
  });
}

/**
 * Split a raw dataset into valid posts and rejected rows. Duplicate shortcodes (the scraper
 * can repeat a post across pages) collapse to the first occurrence, keeping run order.
 */
export function partitionPosts(items: readonly unknown[]): PartitionedPosts {
  const posts: InstagramPost[] = [];
  const rejected: RejectedItem[] = [];
  const seen = new Set<string>();

  items.forEach((raw, index) => {
    const result = parseInstagramPost(raw);
    if (!result.ok) {
      rejected.push({ index, reason: result.error });
      return;
    }
    if (seen.has(result.value.shortCode)) return;
    seen.add(result.value.shortCode);
    posts.push(result.value);
  });

  return { posts, rejected };
}
