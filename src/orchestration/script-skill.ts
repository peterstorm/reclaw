import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveSkillEnvironment } from '../core/agent-environment.js';
import type { ScriptModule, ScriptOutcome } from '../core/script-skill.js';
import type { SkillConfig } from '../core/types.js';
import { type Result, err, ok } from '../core/types.js';
import { createScriptStateDir } from '../infra/script-workdir.js';

/**
 * The script-skill runner: the imperative shell around one script invocation.
 * Loads the module, builds the per-skill context (state dir under the state
 * root, granted environment, clock) and races `run` against the skill timeout.
 * A throw or a timeout is a failed run; the outcome itself is the script's.
 */

export type ScriptSkillDeps = {
  /** The skills directory every `script:` file name resolves against. */
  readonly skillsDir: string;
  /** Root of the per-skill state directories, e.g. `~/.cache/reclaw/script-skills`. */
  readonly stateRoot: string;
  /** Service environment the skill's grants filter (`process.env` in production). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Hard ceiling on one `run` invocation. */
  readonly timeoutMs: number;
  readonly now: () => Date;
  /** Module loader; production resolves a file URL and dynamic-imports it. */
  readonly importModule: (absolutePath: string) => Promise<ScriptModule>;
};

/** Production module loader: the module file is a file URL, imported dynamically. */
export const importScriptModule = async (absolutePath: string): Promise<ScriptModule> => {
  const { pathToFileURL } = await import('node:url');
  const mod = (await import(pathToFileURL(absolutePath).href)) as Partial<ScriptModule>;
  if (typeof mod?.run !== 'function') {
    throw new Error(`script module ${absolutePath} does not export run(context)`);
  }
  return { run: mod.run };
};

/** `~/.cache/reclaw/script-skills` — next to the legacy watcher state files. */
export const defaultScriptStateRoot = (): string =>
  join(homedir(), '.cache', 'reclaw', 'script-skills');

/** Race `promise` against a timer that is cleaned up and never holds shutdown. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`script timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** Run one script skill end-to-end. Never throws. */
export const runScriptSkill = async (
  skill: SkillConfig & { readonly script: string },
  deps: ScriptSkillDeps,
): Promise<Result<ScriptOutcome, string>> => {
  try {
    const mod = await deps.importModule(`${deps.skillsDir}/${skill.script}`);
    const context = {
      skillId: skill.id,
      stateDir: createScriptStateDir(`${deps.stateRoot}/${skill.id}`),
      env: resolveSkillEnvironment(deps.env, skill.environment),
      now: deps.now,
    };
    const outcome = await withTimeout(mod.run(context), deps.timeoutMs);
    return ok(outcome);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(`script "${skill.script}" failed: ${message}`);
  }
};
