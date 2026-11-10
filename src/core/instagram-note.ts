import type { InstagramPost } from './instagram-post.js';
import { type Transcript, transcriptLines } from './instagram-transcript.js';
import { type VaultRelativePath, parseVaultRelativePath } from './vault-path.js';

// ─── Layout ───────────────────────────────────────────────────────────────────

export const INSTAGRAM_MOC_PATH = 'media/instagram/MOC.md' as VaultRelativePath;
const INSTAGRAM_MOC_LINK = 'media/instagram/MOC';

/** What went into a note beyond the caption. `no-video` = photo or video-less carousel. */
export type NoteBody =
  | {
      readonly kind: 'transcribed';
      readonly transcript: Transcript;
      /** Absolute path of the kept video file, or null when video was not requested. */
      readonly videoPath: string | null;
    }
  | { readonly kind: 'no-video' };

export type NoteInput = Readonly<{
  post: InstagramPost;
  body: NoteBody;
  /** `YYYY-MM-DD` the note was written. */
  ingestedOn: string;
}>;

/** `media/instagram/<owner>/<shortcode>.md` — both segments are branded path-safe. */
export function instagramNotePath(post: InstagramPost): VaultRelativePath {
  const parsed = parseVaultRelativePath(`media/instagram/${post.owner}/${post.shortCode}.md`);
  if (!parsed.ok)
    throw new Error(`branded segments produced an invalid vault path: ${parsed.error}`);
  return parsed.value;
}

/** Wikilink target for a note path: vault-relative, no extension. */
const noteLinkTarget = (path: VaultRelativePath): string => path.replace(/\.md$/i, '');

// ─── Title ────────────────────────────────────────────────────────────────────

const TITLE_MAX = 80;

/** First non-empty caption line, trimmed to a readable length; falls back to handle + code. */
export function instagramNoteTitle(post: InstagramPost): string {
  const firstLine = post.caption
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined) return `@${post.owner} — ${post.shortCode}`;
  return firstLine.length <= TITLE_MAX
    ? firstLine
    : `${firstLine.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

/** Wikilink aliases cannot contain `|` or brackets. */
const wikilinkSafe = (text: string): string =>
  text.replace(/\|/g, '/').replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim();

// ─── Note ─────────────────────────────────────────────────────────────────────

const yamlString = (value: string): string => JSON.stringify(value);

const dateOf = (iso: string): string => iso.slice(0, 10);

const frontmatter = ({ post, body, ingestedOn }: NoteInput): string => {
  const lines = [
    '---',
    `title: ${yamlString(instagramNoteTitle(post))}`,
    `date: ${dateOf(post.postedAt)}`,
    `tags: [instagram, ${body.kind === 'transcribed' ? 'video' : 'image'}]`,
    'aliases: []',
    `up: "[[${INSTAGRAM_MOC_LINK}|Instagram]]"`,
    `source: ${yamlString(post.url)}`,
    `author: ${post.owner}`,
    `shortcode: ${post.shortCode}`,
    `posted: ${post.postedAt}`,
    `ingested: ${ingestedOn}`,
  ];
  if (body.kind === 'transcribed') {
    lines.push(`language: ${body.transcript.language}`);
    if (post.media.kind === 'video' && post.media.durationSeconds !== null) {
      lines.push(`duration: ${Math.round(post.media.durationSeconds)}`);
    }
    if (body.videoPath !== null) lines.push(`video: ${yamlString(body.videoPath)}`);
  }
  lines.push('---');
  return lines.join('\n');
};

const statsLine = (post: InstagramPost): string => {
  const parts = [
    `[@${post.owner}](https://www.instagram.com/${post.owner}/)`,
    dateOf(post.postedAt),
  ];
  if (post.likes !== null) parts.push(`${post.likes} likes`);
  if (post.comments !== null) parts.push(`${post.comments} comments`);
  return `> ${parts.join(' · ')} · [original](${post.url})`;
};

const transcriptSection = (transcript: Transcript): string => {
  const lines = transcriptLines(transcript);
  return lines.length === 0
    ? '## Transcript\n\n_No speech detected._'
    : `## Transcript\n\n${lines.join('\n')}`;
};

/** Render the full Markdown note. Pure: same input, same note. */
export function renderInstagramNote(input: NoteInput): string {
  const { post, body } = input;
  const sections = [
    frontmatter(input),
    `# ${instagramNoteTitle(post)}`,
    statsLine(post),
    `## Caption\n\n${post.caption.trim().length > 0 ? post.caption.trim() : '_No caption._'}`,
    body.kind === 'transcribed' ? transcriptSection(body.transcript) : '_No video in this post._',
  ];
  return `${sections.join('\n\n')}\n`;
}

// ─── Map of content ───────────────────────────────────────────────────────────

const MOC_HEADER = [
  '---',
  'title: Instagram',
  'date: {{date}}',
  'tags: [moc, instagram]',
  'aliases: []',
  'up: "[[_index]]"',
  '---',
  '# Instagram',
  '',
  'Posts and reels ingested by `scripts/ig-ingest.ts` (caption + local Whisper transcript).',
  '',
].join('\n');

export type MocEntry = Readonly<{
  linkTarget: string;
  title: string;
  owner: string;
  postedOn: string;
}>;

export const mocEntryOf = (post: InstagramPost): MocEntry => ({
  linkTarget: noteLinkTarget(instagramNotePath(post)),
  title: instagramNoteTitle(post),
  owner: post.owner,
  postedOn: dateOf(post.postedAt),
});

const mocLine = (e: MocEntry): string =>
  `- [[${e.linkTarget}|${wikilinkSafe(e.title)}]] — @${e.owner}, ${e.postedOn}`;

/** Add entries to the MOC (creating it when absent). Entries already linked are not repeated. */
export function addMocEntries(
  existing: string | null,
  entries: readonly MocEntry[],
  today: string,
): string {
  const base = existing ?? MOC_HEADER.replace('{{date}}', today);
  const fresh = entries.filter((e) => !base.includes(`[[${e.linkTarget}|`));
  if (fresh.length === 0) return base;
  const separator = base.endsWith('\n') ? '' : '\n';
  return `${base}${separator}${fresh.map(mocLine).join('\n')}\n`;
}

// ─── Vault changelog ──────────────────────────────────────────────────────────

/** Add one bullet under today's `## YYYY-MM-DD` heading, creating the heading when needed. */
export function addChangelogEntry(existing: string, today: string, bullet: string): string {
  const heading = `## ${today}`;
  const lines = existing.split('\n');
  const headingAt = lines.indexOf(heading);
  if (headingAt !== -1) {
    const insertAt =
      headingAt + 1 < lines.length && lines[headingAt + 1] === '' ? headingAt + 2 : headingAt + 1;
    return [...lines.slice(0, insertAt), bullet, ...lines.slice(insertAt)].join('\n');
  }
  const titleAt = lines.findIndex((l) => l.startsWith('# '));
  if (titleAt === -1) return `${existing}\n${heading}\n\n${bullet}\n`;
  return [
    ...lines.slice(0, titleAt + 1),
    '',
    heading,
    '',
    bullet,
    ...lines.slice(titleAt + 1),
  ].join('\n');
}

/** One changelog bullet for a batch of freshly saved posts; null when nothing was saved. */
export function ingestChangelogBullet(posts: readonly InstagramPost[]): string | null {
  const [first] = posts;
  if (first === undefined) return null;
  if (posts.length === 1) {
    const target = noteLinkTarget(instagramNotePath(first));
    return `- **added** [[${target}]] to \`media/instagram/${first.owner}/\` — Instagram ${
      first.media.kind === 'video' ? 'video' : 'post'
    } by @${first.owner}, caption${first.media.kind === 'video' ? ' + Whisper transcript' : ''}`;
  }
  const owners = [...new Set(posts.map((p) => `@${p.owner}`))].join(', ');
  return `- **added** ${posts.length} Instagram posts by ${owners} to [[${INSTAGRAM_MOC_LINK}]] — captions + Whisper transcripts`;
}
