#!/usr/bin/env bun

/**
 * learn (I/O shell) — the command surface of the learning loop. All decisions live in
 * the pure core (`src/core/study-plan.ts`) behind `src/orchestration/learn-command.ts`;
 * this file only wires the filesystem vault adapter and the clock.
 *
 * Usage: bun scripts/learn.ts <command> [...]   (run with no args for the command list)
 * Prints one JSON object on stdout, except for a `--message` command or `round-result`,
 * which print the finished Telegram message as text for the skill to relay verbatim.
 * Exit 1 with the reason on stderr when a command is refused (unknown card, corrupt
 * log, …) — nothing is written in that case.
 *
 * Env: RECLAW_VAULT_ROOT overrides the vault location (default ~/dev/notes/remotevault).
 */

import { DEFAULT_VAULT_ROOT, fsLearningVault } from '../src/infra/learning-vault.js';
import { resolveStdinArgs } from '../src/orchestration/learn-args.js';
import { runLearnCommand } from '../src/orchestration/learn-command.js';

// `grade … --answer -`, `signal -` and `propose -` take their free text from stdin, so skills can
// pass it through a quoted heredoc instead of shell-quoting it ($, backticks and quotes stay
// literal). Which commands do so, and that no other reads stdin, is pinned in learn-args.test.ts.
const args = await resolveStdinArgs(process.argv.slice(2), () => Bun.stdin.text());

const vault = fsLearningVault(process.env.RECLAW_VAULT_ROOT ?? DEFAULT_VAULT_ROOT);
const result = await runLearnCommand(args, vault, new Date());

if (result.ok) {
  process.stdout.write(
    result.value.kind === 'text'
      ? `${result.value.text}\n`
      : `${JSON.stringify(result.value.value, null, 2)}\n`,
  );
} else {
  process.stderr.write(`learn: ${result.error}\n`);
  process.exit(1);
}
