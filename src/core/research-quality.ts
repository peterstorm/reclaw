// ─── Research Quality Evaluator ────────────────────────────────────────────────
//
// Pure functions to compute research metrics from a completed ResearchContext
// and evaluate the quality grade with human-readable warnings.
//
// US6: Quality Evaluation and Warnings — grade research output quality before
// notifying. "good" (all answered with citations), "partial" (warnings present),
// "poor" (multiple warnings).
//
// SC-006: Average citation density across successful research jobs should be
// at least 2 citations per Q&A answer.
//
// Quality rules (from spec US6 and plan):
//   - Completeness: <50% questions answered -> warning
//   - Citation density: <1 avg citation per answer -> warning
//   - Source diversity: <=1 source cited despite >3 available -> warning
//
// Grade thresholds:
//   - 0 warnings = "good"
//   - 1 warning  = "partial"
//   - 2+ warnings = "poor"

import type { ResearchContext, ResearchMetrics, QualityResult } from './research-types.js';

// ─── Thresholds ────────────────────────────────────────────────────────────────

/** Minimum fraction of questions that must be answered to avoid a completeness warning. */
const COMPLETENESS_THRESHOLD = 0.5;

/** Minimum average citations per answered question to avoid a citation density warning. */
const CITATION_DENSITY_THRESHOLD = 1;

/**
 * If the notebook has more than this many sources available, but only this many
 * or fewer are actually cited, a source diversity warning is raised.
 */
const SOURCE_DIVERSITY_AVAILABLE_MIN = 3;
const SOURCE_DIVERSITY_CITED_MAX = 1;

// ─── computeMetrics ───────────────────────────────────────────────────────────

/**
 * Compute aggregated metrics from a completed (or partially completed)
 * ResearchContext.
 *
 * Pure function — no I/O, no side effects.
 *
 * Metrics computed:
 * - questionsAsked: total questions generated
 * - questionsAnswered: questions with a recorded answer
 * - questionsSkipped: questions that were skipped
 * - totalCitations: sum of citation counts across all answers
 * - sourcesIngested: number of sources in context.sources
 * - chatsUsed: from context.chatsUsed
 * - durationMs: elapsed time from startedAt to now (at compute time)
 * - avgCitationsPerAnswer: totalCitations / questionsAnswered (0 if none answered)
 * - sourcesCited: count of unique source indices cited across all answers
 */
export function computeMetrics(
  ctx: ResearchContext,
  now: number = Date.now(),
): ResearchMetrics {
  const questionsAsked = ctx.questions.length;
  const questionsAnswered = Object.keys(ctx.answers).length;
  const questionsSkipped = ctx.skippedQuestions.length;

  // Sum total citations across all answers
  let totalCitations = 0;
  const citedSourceIndices = new Set<number>();

  for (const answer of Object.values(ctx.answers)) {
    totalCitations += answer.citations.length;
    for (const idx of answer.citations) {
      citedSourceIndices.add(idx);
    }
  }

  const sourcesIngested = ctx.sources.length;
  const chatsUsed = ctx.chatsUsed;

  // Compute duration from startedAt to now
  const startMs = new Date(ctx.startedAt).getTime();
  const durationMs = Number.isNaN(startMs) ? 0 : now - startMs;

  // Average citations per answered question; 0 if no questions were answered
  const avgCitationsPerAnswer =
    questionsAnswered > 0 ? totalCitations / questionsAnswered : 0;

  const sourcesCited = citedSourceIndices.size;

  return {
    questionsAsked,
    questionsAnswered,
    questionsSkipped,
    totalCitations,
    sourcesIngested,
    chatsUsed,
    durationMs,
    avgCitationsPerAnswer,
    sourcesCited,
  };
}

// ─── evaluateQuality ──────────────────────────────────────────────────────────

/**
 * Evaluate the quality of a completed research job and produce a grade with
 * human-readable warnings.
 *
 * Pure function — no I/O, no side effects.
 *
 * Quality rules (US6, plan):
 *   1. Completeness: if <50% of questions were answered -> warning
 *   2. Citation density: if avg citations per answer < 1 -> warning
 *   3. Source diversity: if <=1 source cited despite >3 sources available -> warning
 *
 * Grade:
 *   - 0 warnings -> "good"
 *   - 1 warning  -> "partial"
 *   - 2+ warnings -> "poor"
 */
export function evaluateQuality(
  _ctx: ResearchContext,
  metrics: ResearchMetrics,
): QualityResult {
  const warnings: string[] = [];

  // Rule 1 — Completeness
  // If no questions were asked, we can't compute a ratio; skip this warning.
  if (metrics.questionsAsked > 0) {
    const answeredFraction = metrics.questionsAnswered / metrics.questionsAsked;
    if (answeredFraction < COMPLETENESS_THRESHOLD) {
      warnings.push(
        `Low completeness: only ${metrics.questionsAnswered} of ${metrics.questionsAsked} questions were answered ` +
          `(${Math.round(answeredFraction * 100)}% < ${COMPLETENESS_THRESHOLD * 100}% threshold).`,
      );
    }
  }

  // Rule 2 — Citation density
  // Only raise the warning if at least one question was answered but density is too low.
  if (metrics.questionsAnswered > 0 && metrics.avgCitationsPerAnswer < CITATION_DENSITY_THRESHOLD) {
    warnings.push(
      `Low citation density: average ${metrics.avgCitationsPerAnswer.toFixed(2)} citations per answer ` +
        `(threshold: ${CITATION_DENSITY_THRESHOLD} citations per answer).`,
    );
  }

  // Rule 3 — Source diversity
  // Warn only when more than SOURCE_DIVERSITY_AVAILABLE_MIN sources are available
  // but only SOURCE_DIVERSITY_CITED_MAX or fewer were actually cited.
  if (
    metrics.sourcesIngested > SOURCE_DIVERSITY_AVAILABLE_MIN &&
    metrics.sourcesCited <= SOURCE_DIVERSITY_CITED_MAX
  ) {
    warnings.push(
      `Low source diversity: only ${metrics.sourcesCited} source(s) cited despite ` +
        `${metrics.sourcesIngested} sources being available.`,
    );
  }

  // Grade
  const grade =
    warnings.length === 0 ? 'good' : warnings.length === 1 ? 'partial' : 'poor';

  return {
    grade,
    warnings,
  };
}
