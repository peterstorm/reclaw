/**
 * The in-process scheduled-skill contract ("script skills").
 *
 * A script skill's YAML names a TypeScript module in the skills directory
 * (`script: my-job.ts`). The module exports `run(context)`; the service calls
 * it on every scheduled fire — no agent subprocess, no LLM. The module imports
 * its pure logic from `src/core/`, does its own I/O through the injected
 * ports (stateDir, env, now), and returns a message or silence.
 *
 * Errors: a `run` that throws (or exceeds the skill timeout) fails the job and
 * lets BullMQ retry it — a script should return `silent` for expected
 * nothing-to-report conditions, not throw.
 */

import type { SkillId } from './types.js';

/**
 * A per-skill persistent directory. Survives between runs (that is the point):
 * scripts keep their diff state here. `readFile` resolves `undefined` for an
 * absent file — absence is a value, not an error. Writes are atomic
 * (temp file + rename), so a crash never leaves a half-written state.
 */
export type ScriptStateDir = {
  readonly readFile: (name: string) => Promise<string | undefined>;
  readonly writeFileAtomic: (name: string, contents: string) => Promise<void>;
  /** Delete a file if it exists; resolves either way. */
  readonly remove: (name: string) => Promise<void>;
};

/** What one script invocation receives. All I/O collaborators are injected. */
export type ScriptContext = {
  readonly skillId: SkillId;
  readonly stateDir: ScriptStateDir;
  /** The skill's explicitly granted service-environment values (undefined values omitted). */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => Date;
};

/** What one script invocation produces. */
export type ScriptOutcome =
  /** Sent to every authorized user. */
  | { readonly kind: 'message'; readonly text: string }
  /** Nothing to report — no message is delivered. */
  | { readonly kind: 'silent' };

export type ScriptRun = (context: ScriptContext) => Promise<ScriptOutcome>;

/** The shape a script module must export. */
export type ScriptModule = { readonly run: ScriptRun };
