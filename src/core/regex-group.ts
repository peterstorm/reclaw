// ─── Mandatory Regex Capture Groups ──────────────────────────────────────────
//
// `noUncheckedIndexedAccess` types every capture group as `string | undefined`,
// even a group the pattern makes mandatory. Reading one through this helper
// states that guarantee at the call site and fails loudly if the pattern and
// the caller ever disagree, instead of carrying `undefined` onward.

/**
 * Read a capture group that the pattern makes mandatory (not inside an
 * optional `(…)?` or an untaken alternation branch). A successful match always
 * fills such a group, so a missing one is a programming error and throws.
 */
export function requiredGroup(match: RegExpMatchArray, index: number): string {
  const group = match[index];
  if (group === undefined) {
    throw new Error(`regex capture group ${index} did not participate in the match`);
  }
  return group;
}
