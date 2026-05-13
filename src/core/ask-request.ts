// ─── Ask Request Parser ─────────────────────────────────────────────────────────
//
// Parses /ask Telegram commands. Format:
//   /ask <topic-slug> <question…>
//
// The slug points to a research topic the user previously ran via /research.
// The handler resolves the slug to a NotebookLM notebook id and runs a
// one-shot chat against that notebook.

import { type Result, ok, err } from './types.js';

export type AskRequest = {
  readonly slug: string;
  readonly question: string;
};

const USAGE = 'Usage: /ask <topic-slug> <question>';

export function parseAskCommand(text: string): Result<AskRequest, string> {
  const trimmed = text.trim();
  const prefix = '/ask';
  if (!trimmed.toLowerCase().startsWith(prefix)) {
    return err('Message does not start with /ask.');
  }

  const remainder = trimmed.slice(prefix.length).replace(/^\s+/, '');
  if (remainder.length === 0) {
    return err(USAGE);
  }

  // First whitespace-delimited token is the slug; everything after is the question.
  // Use [\s\S] for the tail so newlines in long questions are kept.
  const match = remainder.match(/^(\S+)\s+([\s\S]+)$/);
  if (match === null) {
    return err(USAGE);
  }

  const slug = match[1]!.trim();
  const question = match[2]!.trim();

  if (slug.length === 0) {
    return err(USAGE);
  }
  if (question.length === 0) {
    return err('Question must not be empty.');
  }

  return ok({ slug, question });
}
