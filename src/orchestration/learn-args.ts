// ─── Learn argv: stdin placeholders ───────────────────────────────────────────
//
// Skills pass free text (a learner's answer, a batch of tagged items) through a quoted heredoc
// on stdin instead of shell-quoting it, so `$`, backticks and quotes stay literal. A `-` stands
// where the text goes. Resolving it is the one thing the entry script does before the command
// runs; it lives here so a test can pin which commands read stdin and which never do.

/** Where in `args` a `-` placeholder asks for stdin, or -1: `grade … --answer -`, `signal -`, `propose -`. */
function placeholderAt(args: readonly string[]): number {
  const answer = args.indexOf('--answer');
  if (args[0] === 'grade' && answer !== -1 && args[answer + 1] === '-') return answer + 1;
  if ((args[0] === 'signal' || args[0] === 'propose') && args[1] === '-') return 1;
  return -1;
}

/**
 * `args` with its stdin placeholder replaced by the trimmed stdin text. Stdin is read only when
 * a placeholder is present, so a command that takes none never waits on it.
 */
export async function resolveStdinArgs(
  args: readonly string[],
  readStdin: () => Promise<string>,
): Promise<readonly string[]> {
  const at = placeholderAt(args);
  if (at === -1) return args;
  const text = (await readStdin()).trim();
  return args.map((arg, i) => (i === at ? text : arg));
}
