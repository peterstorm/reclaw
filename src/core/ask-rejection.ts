// ─── /ask Rejection ─────────────────────────────────────────────────────────────
//
// Why an /ask command is answered before any NotebookLM chat is spent, and the
// reply for each cause. The router resolves the target; this words the refusal.

import { assertNever } from './types.js';

export type AskRejection =
  /** The NotebookLM adapter or the vault path is not configured for /ask. */
  | { readonly kind: 'not-wired' }
  /** The command did not parse; `reason` is the parser's reply. */
  | { readonly kind: 'invalid-command'; readonly reason: string }
  /** The topic's hub note or notebook id could not be read; `reason` says why. */
  | { readonly kind: 'topic-unavailable'; readonly reason: string }
  | { readonly kind: 'quota-exhausted' }
  /** The lazy NotebookLM adapter has no credentials on this instance. */
  | { readonly kind: 'notebooklm-unconfigured' };

/** The reply to a rejected /ask. */
export function formatAskRejection(rejection: AskRejection): string {
  switch (rejection.kind) {
    case 'not-wired':
      return '/ask is not wired up — NotebookLM adapter or vault path missing.';
    case 'invalid-command':
    case 'topic-unavailable':
      return rejection.reason;
    case 'quota-exhausted':
      return 'Daily NotebookLM chat quota exhausted. Try again tomorrow.';
    case 'notebooklm-unconfigured':
      return 'NotebookLM is not configured on this reclaw instance.';
    default:
      return assertNever(rejection);
  }
}
