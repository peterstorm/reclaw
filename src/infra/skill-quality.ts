/**
 * Fire-and-forget cortex memory recorder for skill execution quality signals.
 *
 * Spawns the cortex engine CLI's `remember` subcommand in the background.
 * Errors are logged but never propagated — quality tracking must never block
 * or fail a scheduled job.
 */

import { toMemory, type SkillQualitySignal } from '../core/skill-quality.js';

export type SkillQualityRecorder = (signal: SkillQualitySignal) => void;

/**
 * Create a recorder bound to a resolved cortex CLI path and project cwd.
 *
 * The recorder filters signals through `toMemory` (anomalies-only policy);
 * non-recordable signals are silently dropped without spawning anything.
 */
export function createSkillQualityRecorder(
  cliPath: string,
  cwd: string,
): SkillQualityRecorder {
  return (signal: SkillQualitySignal): void => {
    const memory = toMemory(signal);
    if (memory === null) return;

    void (async () => {
      const args = [
        'run',
        cliPath,
        'remember',
        cwd,
        memory.content,
        `--type=${memory.type}`,
        `--priority=${memory.priority}`,
        `--tags=${memory.tags.join(',')}`,
      ];
      if (memory.pinned) args.push('--pinned');

      const proc = Bun.spawn(['bun', ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: process.env,
      });

      // Drain both pipes concurrently with exit. Without draining, a large
      // stdout/stderr write fills the pipe buffer and blocks the child waiting
      // for a reader while the parent waits for `proc.exited` — same deadlock
      // pattern guarded against in claude-subprocess.ts. The cortex remember
      // CLI normally writes little, but this defends against a verbose error.
      const stdoutPromise = new Response(proc.stdout).text().catch(() => '');
      const stderrPromise = new Response(proc.stderr).text().catch(() => '');

      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await stderrPromise;
        console.error(
          `[skill-quality] remember exited ${exitCode} for skill=${signal.skillId} status=${signal.status}: ${stderr.trim()}`,
        );
      }
      void stdoutPromise; // drained for back-pressure only — its .catch already absorbs rejections
    })().catch((err: unknown) => {
      console.error(`[skill-quality] recorder failed: ${err}`);
    });
  };
}
