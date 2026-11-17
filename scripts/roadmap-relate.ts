#!/usr/bin/env bun

/**
 * roadmap-relate (I/O shell) — bookkeeping for the `roadmap-relate` skill, which keeps the
 * generic AI-engineering roadmap current from its sources and maps it onto our repos.
 * Every decision is `src/core/roadmap-relate.ts`; this file gathers facts and persists state.
 *
 *   bun scripts/roadmap-relate.ts plan                fetch repos, decide this run's work (JSON)
 *   bun scripts/roadmap-relate.ts digest CODE...      what those reels add beyond their captions
 *   bun scripts/roadmap-relate.ts mark-folded CODE... record reels as folded
 *   bun scripts/roadmap-relate.ts sources SINCE       what the source feeds published since SINCE
 *   bun scripts/roadmap-relate.ts mark-swept          record the sweep (as of the last plan)
 *   bun scripts/roadmap-relate.ts mark-mapped         record the mapping (heads from the last plan)
 *   bun scripts/roadmap-relate.ts set-section reels|signals FILE
 *        replace a skill-owned section (between its markers) with FILE's contents:
 *        `reels` in the bashi_fuirkashi source note, `signals` in the roadmap
 *
 * Repos are read at their default branch (`origin/HEAD`) after a best-effort `git fetch`; the
 * script never checks out, stashes or resets — other sessions work in those checkouts.
 *
 * Env: RECLAW_VAULT_ROOT (default ~/dev/notes/remotevault),
 *      RECLAW_ROADMAP_STATE (default ~/.cache/reclaw/roadmap-relate.json).
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { selectRecentUnseen, sortNewestFirst } from '../src/core/feed-parser.js';
import {
  EMPTY_STATE,
  type MarkedSection,
  type Reel,
  type RelateFacts,
  type RelateState,
  type RepoHead,
  markFolded,
  markMapped,
  markSwept,
  parseRelateFacts,
  parseRelateState,
  planRelate,
  replaceSection,
} from '../src/core/roadmap-relate.js';
import { type Feed, fetchFeeds } from '../src/infra/feed-fetcher.js';

const run = promisify(execFile);

const VAULT = process.env.RECLAW_VAULT_ROOT ?? join(homedir(), 'dev/notes/remotevault');
const STATE_FILE =
  process.env.RECLAW_ROADMAP_STATE ?? join(homedir(), '.cache/reclaw/roadmap-relate.json');
const PLAN_FILE = STATE_FILE.replace(/\.json$/, '-plan.json');

/** The generic roadmap: what is mapped onto the repos, and whose hash triggers a remap. */
const ROADMAP_NOTE = 'programming/ai/roadmap/ai-engineering-roadmap.md';
/** One source of the roadmap: the @bashi_fuirkashi extract, which the reels are folded into. */
const REEL_NOTE = 'programming/ai/roadmap/bashi-fuirkashi-ai-engineering-roadmap.md';
const MAPPING_NOTE = 'programming/ai/roadmap/ai-engineering-roadmap-vs-our-repos.md';
const REELS_DIR = 'media/instagram/bashi_fuirkashi';

/** The sections this skill owns; everything outside their markers is hand-curated. */
const SECTIONS: Readonly<Record<'reels' | 'signals', MarkedSection & { note: string }>> = {
  reels: {
    note: REEL_NOTE,
    start: '<!-- roadmap-relate:reels:start -->',
    end: '<!-- roadmap-relate:reels:end -->',
  },
  signals: {
    note: ROADMAP_NOTE,
    start: '<!-- roadmap-relate:signals:start -->',
    end: '<!-- roadmap-relate:signals:end -->',
  },
};

/** The roadmap's sources that publish feeds (each verified to serve one, 2026-11-17). */
const SOURCE_FEEDS: readonly Feed[] = [
  // Core role: evals, RAG, production, the market.
  { source: 'Hamel Husain', url: 'https://hamel.dev/index.xml' },
  { source: 'Eugene Yan', url: 'https://eugeneyan.com/rss/' },
  { source: 'Chip Huyen', url: 'https://huyenchip.com/feed.xml' },
  { source: 'Alexey Grigorev (AI Shipping)', url: 'https://aishippingblog.com/feed' },
  { source: 'DataTalks.Club', url: 'https://datatalks.club/feed.xml' },
  { source: 'Jason Liu', url: 'https://jxnl.co/feed_rss_created.xml' },
  { source: 'Latent Space', url: 'https://www.latent.space/feed' },
  { source: 'Simon Willison', url: 'https://simonwillison.net/atom/everything/' },
  // Harness engineering and agentic coding. Anthropic publishes no feed; this is a public
  // third-party mirror of anthropic.com/engineering.
  {
    source: 'Anthropic Engineering (mirror)',
    url: 'https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_engineering.xml',
  },
  { source: 'Martin Fowler', url: 'https://martinfowler.com/feed.atom' },
  // Memory (Letta and Mem0 publish no feed; Zep is a vendor).
  { source: 'Zep', url: 'https://www.getzep.com/blog/rss.xml' },
  { source: 'Lilian Weng', url: 'https://lilianweng.github.io/index.xml' },
  // Self-improvement, AI R&D automation, measurement.
  { source: 'METR', url: 'https://metr.org/feed.xml' },
  { source: 'Epoch AI', url: 'https://epoch.ai/atom.xml' },
  { source: 'AI Futures Project', url: 'https://blog.aifutures.org/feed' },
  // Reasoning and post-training.
  { source: 'Interconnects (Nathan Lambert)', url: 'https://www.interconnects.ai/feed' },
  { source: 'Sebastian Raschka', url: 'https://magazine.sebastianraschka.com/feed' },
  // Security and protocols.
  { source: 'OWASP GenAI', url: 'https://genai.owasp.org/feed/' },
  { source: 'MCP blog', url: 'https://blog.modelcontextprotocol.io/index.xml' },
];
const SOURCE_ITEMS_PER_FEED = 12;

/** The repos the roadmap is related to. */
const REPOS: readonly Readonly<{ name: string; path: string; what: string }>[] = [
  { name: 'loom', path: '~/dev/claude-plugins/loom', what: 'AI-assisted delivery harness' },
  { name: 'fugue', path: '~/dev/agentic/fugue', what: 'durable agent/workflow runtime' },
  { name: 'reclaw', path: '~/dev/claude-plugins/reclaw', what: 'personal assistant service' },
  { name: 'chatbot', path: '~/dev/web/chatbot', what: 'multi-tenant SMB chatbot product' },
  { name: 'cortex', path: '~/dev/claude-plugins/cortex', what: 'retrieval/memory plugin' },
  {
    name: 'ds4-native',
    path: '~/dev/ds4-native',
    what: 'native-precision DeepSeek-V4.1-Flash inference engine (CUDA, 2× RTX PRO 6000)',
  },
];

const expand = (p: string) => p.replace(/^~/, homedir());
const say = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
function fail(message: string): never {
  process.stderr.write(`roadmap-relate: ${message}\n`);
  process.exit(1);
}

// ─── Facts ────────────────────────────────────────────────────────────────────

const git = async (repo: string, args: readonly string[]) =>
  (
    await run('git', ['-C', repo, ...args], {
      timeout: 90_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
  ).stdout.trim();

type RepoReport = RepoHead &
  Readonly<{
    path: string;
    what: string;
    ref: string;
    committedAt: string | null;
    fetchError: string | null;
  }>;

async function repoHead(repo: (typeof REPOS)[number], fetch: boolean): Promise<RepoReport> {
  const path = expand(repo.path);
  let fetchError: string | null = null;
  if (fetch) {
    try {
      await git(path, ['fetch', '--quiet', 'origin']);
    } catch (e) {
      fetchError = (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? 'fetch failed';
    }
  }
  try {
    const ref = await git(path, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(
      () => 'origin/main',
    );
    const [sha, committedAt] = (await git(path, ['log', '-1', '--format=%H %cI', ref])).split(' ');
    return {
      name: repo.name,
      path,
      what: repo.what,
      ref,
      sha: sha ?? null,
      committedAt: committedAt ?? null,
      fetchError,
    };
  } catch (e) {
    const reason = (e instanceof Error ? e.message : String(e)).split('\n')[0];
    return {
      name: repo.name,
      path,
      what: repo.what,
      ref: '?',
      sha: null,
      committedAt: null,
      fetchError: fetchError ?? reason ?? 'unreadable',
    };
  }
}

const frontmatterField = (text: string, field: string): string | null =>
  text.match(new RegExp(`^${field}:\\s*"?([^"\\n]+)"?\\s*$`, 'm'))?.[1]?.trim() ?? null;

async function reels(): Promise<readonly Reel[]> {
  const dir = join(VAULT, REELS_DIR);
  const files = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.md'));
  const found = await Promise.all(
    files.map(async (f) => {
      const text = await fs.readFile(join(dir, f), 'utf8');
      const shortCode = frontmatterField(text, 'shortcode');
      const postedAt = frontmatterField(text, 'posted');
      return shortCode !== null && postedAt !== null ? [{ shortCode, postedAt }] : [];
    }),
  );
  return found.flat();
}

const roadmapHash = async () =>
  createHash('sha256')
    .update(await fs.readFile(join(VAULT, ROADMAP_NOTE)))
    .digest('hex')
    .slice(0, 16);

async function loadState(): Promise<RelateState> {
  const text = await fs.readFile(STATE_FILE, 'utf8').catch(() => null);
  if (text === null) return EMPTY_STATE;
  const raw: unknown = JSON.parse(text);
  const parsed = parseRelateState(raw);
  if (!parsed.ok) fail(parsed.error);
  return parsed.value;
}

/** The facts the last `plan` saved; the mark-* commands record against them. */
async function plannedFacts(): Promise<RelateFacts> {
  const planned = await fs
    .readFile(PLAN_FILE, 'utf8')
    .catch(() => fail('no plan to mark; run plan first'));
  const raw: unknown = JSON.parse(planned);
  const facts = parseRelateFacts(raw);
  if (!facts.ok) fail(facts.error);
  return facts.value;
}

async function writeAtomically(file: string, text: string) {
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, text);
  await fs.rename(`${file}.tmp`, file);
}

const save = (file: string, value: unknown) =>
  writeAtomically(file, `${JSON.stringify(value, null, 2)}\n`);

// ─── Digest: what a reel says beyond its caption ──────────────────────────────

const DIGEST_SECTIONS = ['Alt text', 'Transcript', 'On-screen text', 'Text in images'];
const DIGEST_MAX_CHARS = 3500;

function digestOf(shortCode: string, text: string): string {
  const title = frontmatterField(text, 'title') ?? shortCode;
  const posted = frontmatterField(text, 'posted')?.slice(0, 10) ?? '?';
  const sections = text.split(/^## /m).slice(1);
  const kept = sections
    .filter((s) => DIGEST_SECTIONS.some((name) => s.startsWith(`${name}\n`)))
    .map((s) => `## ${s.trim()}`)
    .join('\n\n');
  const body =
    kept.length > DIGEST_MAX_CHARS ? `${kept.slice(0, DIGEST_MAX_CHARS)}\n…(truncated)` : kept;
  return `### ${shortCode} · ${posted} · ${title}\n\n${body || '_(no transcript or text)_'}\n`;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

const [command, ...rest] = process.argv.slice(2);

if (command === 'plan') {
  const [state, found, hash, repos] = await Promise.all([
    loadState(),
    reels(),
    roadmapHash(),
    Promise.all(REPOS.map((r) => repoHead(r, true))),
  ]);
  const facts: RelateFacts = {
    now: new Date().toISOString(),
    reels: found,
    roadmapHash: hash,
    repos: repos.map(({ name, sha }) => ({ name, sha })),
  };
  await save(PLAN_FILE, facts);
  say({
    plan: planRelate(state, facts),
    repos,
    roadmapNote: join(VAULT, ROADMAP_NOTE),
    reelNote: join(VAULT, REEL_NOTE),
    mappingNote: join(VAULT, MAPPING_NOTE),
    reelsDir: join(VAULT, REELS_DIR),
    reelsTotal: found.length,
    foldedTotal: state.foldedReels.length,
    lastSwept: state.swept,
  });
} else if (command === 'digest') {
  if (rest.length === 0) fail('digest needs shortcodes');
  for (const code of rest) {
    const text = await fs.readFile(join(VAULT, REELS_DIR, `${code}.md`), 'utf8').catch(() => null);
    process.stdout.write(
      text === null ? `### ${code}\n\n_(note missing)_\n\n` : `${digestOf(code, text)}\n`,
    );
  }
} else if (command === 'mark-folded') {
  if (rest.length === 0) fail('mark-folded needs shortcodes');
  const state = await loadState();
  const next = markFolded(state, rest);
  await save(STATE_FILE, next);
  say({
    folded: next.foldedReels.length,
    added: next.foldedReels.length - state.foldedReels.length,
  });
} else if (command === 'sources') {
  const [since] = rest;
  const cutoffMs = Date.parse(since ?? '');
  if (Number.isNaN(cutoffMs)) fail('sources needs an ISO timestamp (plan.sweep.since)');
  const results = await fetchFeeds(SOURCE_FEEDS, {
    timeoutMs: 25_000,
    userAgent: 'reclaw-roadmap-relate/1.0',
  });
  // An undated item would come back every week; a sweep reads dated posts only.
  const items = results.flatMap(({ items: fetched }) =>
    selectRecentUnseen(
      fetched.filter((i) => i.date !== null),
      { cutoffMs, seen: new Set(), maxPerFeed: SOURCE_ITEMS_PER_FEED },
    ),
  );
  say({
    since,
    count: items.length,
    errors: results.flatMap(({ feed, error }) =>
      error === null ? [] : [{ source: feed.source, error }],
    ),
    items: sortNewestFirst(items),
  });
} else if (command === 'mark-swept') {
  const next = markSwept(await loadState(), await plannedFacts());
  await save(STATE_FILE, next);
  say({ swept: next.swept });
} else if (command === 'mark-mapped') {
  const facts = await plannedFacts();
  // The mapping was made from the roadmap as it is now (after this run's folding and sweeping),
  // against the repo heads the plan fetched.
  const next = markMapped(await loadState(), { ...facts, roadmapHash: await roadmapHash() });
  await save(STATE_FILE, next);
  say({ mapped: next.mapped });
} else if (command === 'set-section') {
  const [name, file] = rest;
  if (name !== 'reels' && name !== 'signals') fail('set-section needs reels|signals FILE');
  if (file === undefined) fail('set-section needs a file');
  const section = SECTIONS[name];
  const path = join(VAULT, section.note);
  const updated = replaceSection(
    await fs.readFile(path, 'utf8'),
    section,
    await fs.readFile(file, 'utf8'),
  );
  if (!updated.ok) fail(`${section.note}: ${updated.error}`);
  await writeAtomically(path, updated.value);
  say({ section: name, note: section.note });
} else {
  fail(
    'usage: roadmap-relate.ts plan | digest CODE... | mark-folded CODE... | sources SINCE | mark-swept | mark-mapped | set-section reels|signals FILE',
  );
}
