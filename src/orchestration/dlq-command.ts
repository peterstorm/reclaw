// ─── /dlq Command ─────────────────────────────────────────────────────────────
//
// Shell orchestrator: load the failed set (port) → triage + plan (pure) → apply
// the plan job by job (port) → format the reply (pure). Every action re-reads the
// failed set first, so a repeated `/dlq retry` or `/dlq clear` acts only on what
// is still failed: running either twice is safe.

import { match } from 'ts-pattern';
import {
  type ActionReport,
  type DeadLetterActionOutcome,
  type DeadLetterStore,
  type DlqCommand,
  formatClearReport,
  formatRetryReport,
  formatTriage,
  planClear,
  planRetry,
  triageDeadLetters,
} from '../core/dead-letter.js';

export type DlqCommandDeps = {
  readonly store: DeadLetterStore;
  readonly now: () => Date;
};

/**
 * Apply one port action to each planned job, sequentially. One job's failure is
 * recorded in the report and does not stop the rest — the reply names it.
 */
async function applyPlan(
  jobIds: readonly string[],
  action: (jobId: string) => Promise<DeadLetterActionOutcome>,
): Promise<ActionReport> {
  const done: string[] = [];
  const gone: string[] = [];
  const failed: { jobId: string; error: string }[] = [];
  for (const jobId of jobIds) {
    try {
      const outcome = await action(jobId);
      (outcome === 'done' ? done : gone).push(jobId);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error(`[dlq] action failed for job ${jobId}: ${error}`);
      failed.push({ jobId, error });
    }
  }
  return { done, gone, failed };
}

/** Run one parsed `/dlq` command and return the reply text. */
export async function runDlqCommand(command: DlqCommand, deps: DlqCommandDeps): Promise<string> {
  const triage = triageDeadLetters(await deps.store.listFailed(), deps.now());

  return match(command)
    .with({ kind: 'list' }, async () =>
      formatTriage(triage, await deps.store.untriagedFailedCounts()),
    )
    .with({ kind: 'retry' }, async () =>
      formatRetryReport(triage, await applyPlan(planRetry(triage), deps.store.retry)),
    )
    .with({ kind: 'clear' }, async () =>
      formatClearReport(triage, await applyPlan(planClear(triage), deps.store.remove)),
    )
    .exhaustive();
}
