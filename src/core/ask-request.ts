// ─── Ask Request Parser ─────────────────────────────────────────────────────────
//
// Parses /ask Telegram commands. Format:
//   /ask <topic-slug> <question…>
//
// The slug points to a research topic the user previously ran via /research.
// The handler resolves the slug to a NotebookLM notebook id and runs a
// one-shot chat against that notebook.

import { type TopicSlug, parseTopicSlugReference } from './topic-slug.js';
import { type Result, err, ok } from './types.js';

export type AskRequest = {
  readonly slug: TopicSlug;
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

  const slugToken = match[1];
  const questionToken = match[2];
  if (slugToken === undefined || questionToken === undefined) return err(USAGE);
  const slug = parseTopicSlugReference(slugToken.trim());
  const question = questionToken.trim();

  if (!slug.ok) {
    return err(`Invalid topic slug: ${slug.error}`);
  }
  if (question.length === 0) {
    return err('Question must not be empty.');
  }

  return ok({ slug: slug.value, question });
}
