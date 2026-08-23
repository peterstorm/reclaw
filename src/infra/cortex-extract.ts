import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

type InstalledPlugins = {
  readonly plugins: Record<string, ReadonlyArray<{ readonly installPath: string }>>;
};

function resolveCortexInstallPath(): string | null {
  const pluginsPath = join(homedir(), '.claude', 'plugins', 'installed_plugins.json');
  try {
    const data: InstalledPlugins = JSON.parse(readFileSync(pluginsPath, 'utf-8'));
    return data.plugins['cortex@local']?.[0]?.installPath ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve the cortex extract-and-generate.sh script path from
 * Claude's installed_plugins.json. Returns null if not found.
 */
export function resolveCortexExtractScript(): string | null {
  const installPath = resolveCortexInstallPath();
  if (installPath === null) return null;
  const scriptPath = join(installPath, 'hooks', 'scripts', 'extract-and-generate.sh');
  return existsSync(scriptPath) ? scriptPath : null;
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
