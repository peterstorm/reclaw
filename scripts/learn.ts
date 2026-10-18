#!/usr/bin/env bun

/**
 * learn (I/O shell) — the command surface of the learning loop. All decisions live in
 * the pure core (`src/core/study-plan.ts`) behind `src/orchestration/learn-command.ts`;
 * this file only wires the filesystem vault adapter and the clock.
 *
 * Usage: bun scripts/learn.ts <command> [...]   (run with no args for the command list)
 * Prints one JSON object on stdout. Exit 1 with the reason on stderr when a command is
 * refused (unknown card, corrupt log, …) — nothing is written in that case.
 *
 * Env: RECLAW_VAULT_ROOT overrides the vault location (default ~/dev/notes/remotevault).
 */

import { DEFAULT_VAULT_ROOT, fsLearningVault } from '../src/infra/learning-vault.js';
import { runLearnCommand } from '../src/orchestration/learn-command.js';

const args = process.argv.slice(2);
// `--answer -` reads the learner's answer from stdin, so skills can pass free text through a
// quoted heredoc instead of shell-quoting it ($, backticks and quotes stay literal).
const answerAt = args.indexOf('--answer');
if (answerAt !== -1 && args[answerAt + 1] === '-') args[answerAt + 1] = (await Bun.stdin.text()).trim();

const vault = fsLearningVault(process.env.RECLAW_VAULT_ROOT ?? DEFAULT_VAULT_ROOT);
const result = await runLearnCommand(args, vault, new Date());

if (result.ok) {
  process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
} else {
  process.stderr.write(`learn: ${result.error}\n`);
  process.exit(1);
}
