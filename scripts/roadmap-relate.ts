#!/usr/bin/env bun

/**
 * roadmap-relate (I/O shell) — bookkeeping for the `roadmap-relate` skill, which keeps the
 * bashi_fuirkashi roadmap note current with the ingested reels and maps it onto our repos.
 * Every decision is `src/core/roadmap-relate.ts`; this file gathers facts and persists state.
 *
 *   bun scripts/roadmap-relate.ts plan               fetch repos, decide this run's work (JSON)
 *   bun scripts/roadmap-relate.ts digest CODE...     what those reels add beyond their captions
 *   bun scripts/roadmap-relate.ts mark-folded CODE... record reels as folded into the roadmap
 *   bun scripts/roadmap-relate.ts mark-mapped        record the mapping (heads from the last plan)
 *   bun scripts/roadmap-relate.ts set-section FILE   replace the roadmap's reel-findings section
 *                                                   (between its markers) with FILE's contents
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
import {
  EMPTY_STATE,
  type Reel,
  type RelateFacts,
  type RelateState,
  type RepoHead,
  markFolded,
  markMapped,
  parseRelateFacts,
  parseRelateState,
  planRelate,
} from '../src/core/roadmap-relate.js';

const run = promisify(execFile);

const VAULT = process.env.RECLAW_VAULT_ROOT ?? join(homedir(), 'dev/notes/remotevault');
const STATE_FILE =
  process.env.RECLAW_ROADMAP_STATE ?? join(homedir(), '.cache/reclaw/roadmap-relate.json');
const PLAN_FILE = STATE_FILE.replace(/\.json$/, '-plan.json');

export const ROADMAP_NOTE = 'programming/ai/bashi-fuirkashi-ai-engineering-roadmap.md';
export const MAPPING_NOTE = 'programming/ai/bashi-roadmap-vs-our-repos.md';
const REELS_DIR = 'media/instagram/bashi_fuirkashi';
/** The roadmap section this skill owns; everything outside the markers is left alone. */
const SECTION_START = '<!-- roadmap-relate:reels:start -->';
const SECTION_END = '<!-- roadmap-relate:reels:end -->';

/** The repos the roadmap is related to. */
const REPOS: readonly Readonly<{ name: string; path: string; what: string }>[] = [
  { name: 'loom', path: '~/dev/claude-plugins/loom', what: 'AI-assisted delivery harness' },
  { name: 'fugue', path: '~/dev/agentic/fugue', what: 'durable agent/workflow runtime' },
  { name: 'reclaw', path: '~/dev/claude-plugins/reclaw', what: 'personal assistant service' },
  { name: 'chatbot', path: '~/dev/web/chatbot', what: 'multi-tenant SMB chatbot product' },
  { name: 'cortex', path: '~/dev/claude-plugins/cortex', what: 'retrieval/memory plugin' },
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

async function save(file: string, value: unknown) {
  await fs.mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(tmp, file);
}

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
    mappingNote: join(VAULT, MAPPING_NOTE),
    reelsDir: join(VAULT, REELS_DIR),
    reelsTotal: found.length,
    foldedTotal: state.foldedReels.length,
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
} else if (command === 'mark-mapped') {
  const planned = await fs
    .readFile(PLAN_FILE, 'utf8')
    .catch(() => fail('no plan to mark; run plan first'));
  const raw: unknown = JSON.parse(planned);
  const facts = parseRelateFacts(raw);
  if (!facts.ok) fail(facts.error);
  // The mapping was made from the roadmap as it is now (after this run's folding), against the
  // repo heads the plan fetched.
  const next = markMapped(await loadState(), { ...facts.value, roadmapHash: await roadmapHash() });
  await save(STATE_FILE, next);
  say({ mapped: next.mapped });
} else if (command === 'set-section') {
  const [file] = rest;
  if (file === undefined) fail('set-section needs a file');
  const body = (await fs.readFile(file, 'utf8')).trim();
  const path = join(VAULT, ROADMAP_NOTE);
  const note = await fs.readFile(path, 'utf8');
  const start = note.indexOf(SECTION_START);
  const end = note.indexOf(SECTION_END);
  if (start === -1 || end < start)
    fail(`${ROADMAP_NOTE} lacks the ${SECTION_START} … ${SECTION_END} markers`);
  if (body.includes(SECTION_START) || body.includes(SECTION_END))
    fail('section text must not contain the markers');
  const updated = `${note.slice(0, start + SECTION_START.length)}\n${body}\n${note.slice(end)}`;
  await fs.writeFile(`${path}.tmp`, updated);
  await fs.rename(`${path}.tmp`, path);
  say({ section: 'reel findings', chars: body.length });
} else {
  fail(
    'usage: roadmap-relate.ts plan | digest CODE... | mark-folded CODE... | mark-mapped | set-section FILE',
  );
}
