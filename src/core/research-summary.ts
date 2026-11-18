// ─── Research Telegram Summary ─────────────────────────────────────────────────
//
// The message a finished research job sends to Telegram. Pure: the notifying
// executor computes metrics and quality, reads the quota, and sends the text.
//
// FR-060: questions answered, citations, sources, quota, grade.
// FR-062: key findings per question (up to 3) and the vault hub link.

import type { QualityResult, ResearchContext, ResearchMetrics } from './research-types.js';

/** Questions whose answers the summary previews. */
const KEY_FINDINGS_SHOWN = 3;

/** Characters of each answer the summary previews. */
const FINDING_PREVIEW_CHARS = 120;

/** A titled bullet section, or nothing when there are no items. */
const bulletSection = (title: string, items: readonly string[]): string =>
  items.length > 0 ? `\n\n${title}:\n${items.map((item) => `• ${item}`).join('\n')}` : '';

const keyFindingsSection = (answers: ResearchContext['answers']): string => {
  const keyFindings = Object.entries(answers)
    .slice(0, KEY_FINDINGS_SHOWN)
    .map(([question, response]) => {
      const preview = response.text.slice(0, FINDING_PREVIEW_CHARS).trim();
      const ellipsis = response.text.length > FINDING_PREVIEW_CHARS ? '...' : '';
      return `Q: ${question}\nA: ${preview}${ellipsis}`;
    })
    .join('\n\n');
  return keyFindings.length > 0 ? `\n\nKey Findings:\n${keyFindings}` : '';
};

/**
 * Build the Telegram research summary. `quotaRemaining` is already rendered:
 * the shell passes '?' when the quota tracker is unreachable.
 */
export function buildTelegramSummary(
  ctx: ResearchContext,
  quality: QualityResult,
  metrics: ResearchMetrics,
  quotaRemaining: string,
): string {
  const hubLink = ctx.hubPath !== null ? `\n\nVault: ${ctx.hubPath}` : '';
  const durationMin = Math.round(metrics.durationMs / 60_000);

  const skippedSection =
    ctx.skippedQuestions.length > 0
      ? `\n\nSkipped questions (${ctx.skippedQuestions.length}): ${ctx.skippedQuestions.join(', ')}`
      : '';
  const warningsText = bulletSection('Warnings', quality.warnings);
  const artifactLinks = bulletSection(
    'Media',
    ctx.artifacts.map((a) => `${a.type === 'audio' ? 'Audio' : 'Video'}: ${a.url}`),
  );
  const artifactFailuresText = bulletSection('Failed artifacts', ctx.artifactFailures);

  return `Research Complete: ${ctx.topic}\n\nQuality: ${quality.grade.toUpperCase()}\nQuestions: ${metrics.questionsAnswered}/${metrics.questionsAsked} answered\nCitations: ${metrics.totalCitations} total, ${metrics.avgCitationsPerAnswer.toFixed(1)} avg/answer\nSources: ${metrics.sourcesIngested} ingested, ${metrics.sourcesCited} cited\nQuota used: ${metrics.chatsUsed} chats, ${quotaRemaining} remaining today\nDuration: ${durationMin}m${skippedSection}${warningsText}${keyFindingsSection(ctx.answers)}${artifactLinks}${artifactFailuresText}${hubLink}`;
}
