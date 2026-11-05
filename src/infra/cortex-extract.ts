import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ─── Pure functions ──────────────────────────────────────────────────────────

/**
 * Mangle a cwd path into Claude CLI's project directory name.
 * Claude CLI replaces every `/` and `.` with `-`.
 *
 * Examples:
 *   /home/user/project        → -home-user-project
 *   /home/user/.dotfiles      → -home-user--dotfiles
 */
export function mangleCwd(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

/**
 * Derive the transcript JSONL path for a given session.
 * Claude CLI stores transcripts at: ~/.claude/projects/<mangled-cwd>/<sessionId>.jsonl
 */
export function deriveTranscriptPath(sessionId: string, cwd: string): string {
  return join(homedir(), '.claude', 'projects', mangleCwd(cwd), `${sessionId}.jsonl`);
}

/** Encode a cwd exactly as Pi's default session manager does. */
export function manglePiCwd(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

/** Resolve Pi's session directory, honoring its documented environment override. */
export function derivePiTranscriptDirectory(
  cwd: string,
  sessionDirectory: string | undefined,
): string {
  return sessionDirectory ?? join(homedir(), '.pi', 'agent', 'sessions', manglePiCwd(cwd));
}

export type PiTranscriptMatch =
  | { readonly kind: 'found'; readonly filename: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'ambiguous'; readonly filenames: readonly string[] };

/** Match Pi's `<timestamp>_<sessionId>.jsonl` filename without fuzzy UUID matching. */
export function matchPiTranscriptFilename(
  sessionId: string,
  filenames: readonly string[],
): PiTranscriptMatch {
  const suffix = `_${sessionId}.jsonl`;
  const matches = filenames.filter((filename) => filename.endsWith(suffix)).sort();
  const [filename, ...remaining] = matches;
  if (filename === undefined) return { kind: 'missing' };
  if (remaining.length === 0) return { kind: 'found', filename };
  return { kind: 'ambiguous', filenames: matches };
}

function isMissingPath(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/** Locate a transcript across the two supported agent backends. */
export function resolveTranscriptPath(sessionId: string, cwd: string): string | null {
  const claudePath = deriveTranscriptPath(sessionId, cwd);
  if (existsSync(claudePath)) return claudePath;

  const piDirectory = derivePiTranscriptDirectory(cwd, process.env.PI_CODING_AGENT_SESSION_DIR);
  let filenames: readonly string[];
  try {
    filenames = readdirSync(piDirectory);
  } catch (error) {
    if (isMissingPath(error)) return null;
    throw error;
  }

  const match = matchPiTranscriptFilename(sessionId, filenames);
  if (match.kind === 'missing') return null;
  if (match.kind === 'ambiguous') {
    throw new Error(
      `Multiple Pi transcripts matched session ${sessionId}: ${match.filenames.join(', ')}`,
    );
  }
  return join(piDirectory, match.filename);
}

// ─── Script resolution ───────────────────────────────────────────────────────

const EXTRACT_SCRIPT = ['hooks', 'scripts', 'extract-and-generate.sh'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Pure: the checkout directory of a directory-source marketplace, or null when
 * the marketplace is absent or is not a directory source (github/git sources
 * have no live checkout to point at).
 */
export function marketplaceDirectory(marketplaces: unknown, marketplace: string): string | null {
  if (!isRecord(marketplaces)) return null;
  const entry = marketplaces[marketplace];
  if (!isRecord(entry) || !isRecord(entry.source)) return null;
  const { source, path } = entry.source;
  return source === 'directory' && typeof path === 'string' ? path : null;
}

/**
 * Pure: the relative source (e.g. `./plugins/cortex`) a marketplace manifest
 * declares for a plugin, or null when absent or not a relative path string.
 */
export function manifestPluginSource(manifest: unknown, plugin: string): string | null {
  if (!isRecord(manifest) || !Array.isArray(manifest.plugins)) return null;
  for (const entry of manifest.plugins) {
    if (isRecord(entry) && entry.name === plugin) {
      return typeof entry.source === 'string' && entry.source.startsWith('./')
        ? entry.source
        : null;
    }
  }
  return null;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * The cache copy Claude recorded at install time. It is a FROZEN snapshot:
 * it does not follow the dev checkout, so on its own it runs stale code.
 */
function resolveCachedCortexRoot(home: string): string | null {
  const data = readJson(join(home, '.claude', 'plugins', 'installed_plugins.json'));
  if (!isRecord(data) || !isRecord(data.plugins)) return null;
  const installs = data.plugins['cortex@local'];
  const first: unknown = Array.isArray(installs) ? installs[0] : undefined;
  const installPath = isRecord(first) ? first.installPath : undefined;
  return typeof installPath === 'string' ? installPath : null;
}

/**
 * The live checkout: the `local` directory-source marketplace declares cortex
 * as a symlink into the dev tree, so following it always yields current code.
 */
function resolveLiveCortexRoot(home: string): string | null {
  const dir = marketplaceDirectory(
    readJson(join(home, '.claude', 'plugins', 'known_marketplaces.json')),
    'local',
  );
  if (dir === null) return null;
  const source = manifestPluginSource(
    readJson(join(dir, '.claude-plugin', 'marketplace.json')),
    'cortex',
  );
  if (source === null) return null;
  try {
    return realpathSync(join(dir, source));
  } catch {
    return null;
  }
}

/**
 * Resolve the cortex extract-and-generate.sh script path. Prefers the live
 * checkout over Claude's frozen cache copy (which ran stale engine code, e.g.
 * missing the stale-embedding backfill fix); falls back to the cache copy only
 * when the live checkout is unavailable. Returns null if neither has the script.
 */
export function resolveCortexExtractScript(home: string = homedir()): string | null {
  const roots = [resolveLiveCortexRoot(home), resolveCachedCortexRoot(home)];
  for (const root of roots) {
    if (root === null) continue;
    const scriptPath = join(root, ...EXTRACT_SCRIPT);
    if (existsSync(scriptPath)) return scriptPath;
  }
  return null;
}

// ─── Awaitable extraction (imperative shell) ─────────────────────────────────

/**
 * Create an awaitable Cortex extraction activity. The delivery outbox owns its
 * retries, so failures must reject instead of disappearing into detached work.
 */
export function createCortexExtractor(
  scriptPath: string,
): (sessionId: string, cwd: string) => Promise<void> {
  return async (sessionId: string, cwd: string): Promise<void> => {
    const transcriptPath = resolveTranscriptPath(sessionId, cwd);
    if (transcriptPath === null) {
      console.warn(
        `[cortex] Transcript not found for session ${sessionId} in Claude or Pi storage — skipping extraction`,
      );
      return;
    }

    const hookInput = JSON.stringify({
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd,
    });

    const proc = Bun.spawn(['bash', scriptPath], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
    });

    proc.stdin.write(new TextEncoder().encode(hookInput));
    proc.stdin.end();

    // Drain both pipes concurrently with exit to prevent pipe-buffer deadlock.
    const stdoutPromise = new Response(proc.stdout).text().catch(() => '');
    const stderrPromise = new Response(proc.stderr).text().catch(() => '');
    const exitCode = await proc.exited;
    await stdoutPromise;

    if (exitCode !== 0) {
      const stderr = await stderrPromise;
      throw new Error(`Cortex extract script exited with code ${exitCode}: ${stderr.trim()}`);
    }
    console.info(`[cortex] Extraction completed for session ${sessionId}`);
  };
}
