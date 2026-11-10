import { type Result, err, ok } from './types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Instagram media shortcode (the `CODE` in `/p/CODE/`). Safe as a filename. */
export type ShortCode = string & { readonly __brand: 'ShortCode' };

/** Instagram handle, lower-cased, without `@`. Safe as a path segment. */
export type InstagramUsername = string & { readonly __brand: 'InstagramUsername' };

/** What the user asked us to ingest: one piece of media, or a whole profile. */
export type InstagramTarget =
  | {
      readonly kind: 'post';
      /** `reel` for reels/IGTV (`/reel/`, `/reels/`, `/tv/`), `post` for `/p/`. */
      readonly format: 'post' | 'reel';
      readonly shortCode: ShortCode;
      /** Canonical, tracking-parameter-free URL handed to the scraper. */
      readonly url: string;
    }
  | {
      readonly kind: 'profile';
      readonly username: InstagramUsername;
      readonly url: string;
    };

// ─── Constructors ─────────────────────────────────────────────────────────────

const SHORT_CODE = /^[A-Za-z0-9_-]{5,40}$/;
/** Letters, digits, `_` and `.`; no leading/trailing/consecutive dots (also keeps it a safe path segment). */
const USERNAME = /^(?!\.)(?!.*\.\.)(?!.*\.$)[A-Za-z0-9._]{1,30}$/;

/** Top-level path segments that are Instagram sections, never profiles. */
const RESERVED_SEGMENTS: ReadonlySet<string> = new Set([
  'p',
  'reel',
  'reels',
  'tv',
  'stories',
  'explore',
  'accounts',
  'direct',
  'about',
  'developer',
  'legal',
  'web',
  'directory',
  'challenge',
  'oauth',
  'api',
]);

export const ShortCode = (raw: string): Result<ShortCode, string> =>
  SHORT_CODE.test(raw) ? ok(raw as ShortCode) : err(`Invalid Instagram shortcode: "${raw}"`);

export const InstagramUsername = (raw: string): Result<InstagramUsername, string> => {
  const handle = raw.replace(/^@/, '');
  if (!USERNAME.test(handle)) return err(`Invalid Instagram username: "${raw}"`);
  if (RESERVED_SEGMENTS.has(handle.toLowerCase())) {
    return err(`"${raw}" is an Instagram section, not a profile.`);
  }
  return ok(handle.toLowerCase() as InstagramUsername);
};

const MEDIA_SEGMENT_FORMAT: Readonly<Record<string, 'post' | 'reel'>> = {
  p: 'post',
  reel: 'reel',
  reels: 'reel',
  tv: 'reel',
};

const buildPostTarget = (
  format: 'post' | 'reel',
  shortCode: ShortCode,
): Extract<InstagramTarget, { kind: 'post' }> => ({
  kind: 'post',
  format,
  shortCode,
  url: `https://www.instagram.com/${format === 'reel' ? 'reel' : 'p'}/${shortCode}/`,
});

const buildProfileTarget = (
  username: InstagramUsername,
): Extract<InstagramTarget, { kind: 'profile' }> => ({
  kind: 'profile',
  username,
  url: `https://www.instagram.com/${username}/`,
});

const isInstagramHost = (host: string): boolean =>
  host === 'instagram.com' || host.endsWith('.instagram.com') || host === 'instagr.am';

/**
 * Parse a user-provided string into an ingest target. Accepts reel/post URLs in every
 * known shape (`/reel/X`, `/reels/X`, `/p/X`, `/tv/X`, `/<user>/reel/X`), profile URLs, and
 * `@handle`. Tracking parameters (`igsh`, `utm_*`) are dropped by construction.
 */
export function parseInstagramTarget(raw: string): Result<InstagramTarget, string> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return err('Instagram URL or @handle is required.');

  if (trimmed.startsWith('@')) {
    const username = InstagramUsername(trimmed);
    return username.ok ? ok(buildProfileTarget(username.value)) : username;
  }

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return err(`Not a valid URL: "${raw}"`);
  }
  if (!isInstagramHost(url.hostname.toLowerCase())) {
    return err(`Not an Instagram URL: "${raw}"`);
  }

  const segments = url.pathname.split('/').filter((s) => s.length > 0);
  const [first, second, third] = segments;
  if (first === undefined) return err(`No profile or media in URL: "${raw}"`);

  if (first.toLowerCase() === 'stories') {
    return err('Stories are not supported (they expire and need a login).');
  }

  const mediaFormat = MEDIA_SEGMENT_FORMAT[first.toLowerCase()];
  if (mediaFormat !== undefined) {
    if (second === undefined) return err(`Missing shortcode in URL: "${raw}"`);
    const shortCode = ShortCode(second);
    return shortCode.ok ? ok(buildPostTarget(mediaFormat, shortCode.value)) : shortCode;
  }

  // `/<user>/reel/<code>` and `/<user>/p/<code>` — the shareable form on the web.
  const nestedFormat =
    second === undefined ? undefined : MEDIA_SEGMENT_FORMAT[second.toLowerCase()];
  if (nestedFormat !== undefined) {
    if (third === undefined) return err(`Missing shortcode in URL: "${raw}"`);
    const shortCode = ShortCode(third);
    return shortCode.ok ? ok(buildPostTarget(nestedFormat, shortCode.value)) : shortCode;
  }

  const username = InstagramUsername(first);
  return username.ok ? ok(buildProfileTarget(username.value)) : username;
}
