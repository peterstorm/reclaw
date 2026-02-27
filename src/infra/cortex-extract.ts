import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

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

// ─── Script resolution ───────────────────────────────────────────────────────

type InstalledPlugins = {
  readonly plugins: Record<string, ReadonlyArray<{ readonly installPath: string }>>;
};

/**
 * Resolve the cortex extract-and-generate.sh script path from
 * Claude's installed_plugins.json. Returns null if not found.
 */
export function resolveCortexExtractScript(): string | null {
  const pluginsPath = join(homedir(), '.claude', 'plugins', 'installed_plugins.json');
  try {
    const data: InstalledPlugins = JSON.parse(readFileSync(pluginsPath, 'utf-8'));
    const firstEntry = data.plugins['cortex@local']?.[0];
    if (!firstEntry) return null;
    const installPath = firstEntry.installPath;
    const scriptPath = join(installPath, 'hooks', 'scripts', 'extract-and-generate.sh');
    return existsSync(scriptPath) ? scriptPath : null;
  } catch {
    return null;
  }
}

// ─── Fire-and-forget extraction (imperative shell) ───────────────────────────

/**
 * Create a fire-and-forget cortex extraction function bound to a resolved script path.
 *
 * After a successful `runClaude` call, invoke the returned function with the session ID
 * and workspace cwd. It spawns `extract-and-generate.sh` in the background, piping the
 * HookInput JSON to stdin. Errors are logged but never propagated.
 */
export function createCortexExtractor(
  scriptPath: string,
): (sessionId: string, cwd: string) => void {
  return (sessionId: string, cwd: string): void => {
    // Async IIFE — fire and forget, never blocks the caller
    void (async () => {
      const transcriptPath = deriveTranscriptPath(sessionId, cwd);
      if (!existsSync(transcriptPath)) {
        console.warn(`[cortex] Transcript not found at ${transcriptPath} — skipping extraction`);
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

      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        let stderr = '';
        try {
          stderr = await new Response(proc.stderr).text();
        } catch { /* ignore */ }
        console.error(`[cortex] Extract script exited with code ${exitCode}: ${stderr.trim()}`);
      } else {
        console.info(`[cortex] Extraction triggered for session ${sessionId}`);
      }
    })().catch((err: unknown) => {
      console.error(`[cortex] Extraction failed: ${err}`);
    });
  };
}
