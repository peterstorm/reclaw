// ─── Topic proposals (pure) ───────────────────────────────────────────────────
//
// Signals tag new material to topics that already exist. Material that fits none used to be
// dropped. A skill that reads something substantive and unplaceable can instead propose a new
// topic, with the item as evidence; the same idea proposed again is the same proposal (its slug
// is derived from its title by code) and its evidence accumulates. Once enough distinct items
// from enough distinct sources agree, the proposal is shown to the user, with the registry entry
// to paste.
//
// The registry stays the user's: nothing here edits it. A proposal is adopted when a topic with
// its slug appears in the registry, and from then on its evidence counts as signals for that
// topic, so the builder reads it when it builds the note. A dismissed proposal is not shown again.

import { z } from 'zod';
import { type Curriculum, type StudySettings, type TopicSlug, findTopic } from './curriculum.js';
import { hash53Hex } from './short-hash.js';
import {
  type Evidence,
  MAX_EVIDENCE_PER_SUBMISSION,
  MAX_PROPOSAL_OUTCOME_CHARS,
  MAX_PROPOSAL_REASON_CHARS,
  MAX_PROPOSAL_SLUG_CHARS,
  MAX_PROPOSAL_TITLE_CHARS,
  type ProposalDismissed,
  type ProposalSlug,
  type SignalNoted,
  type TopicProposed,
} from './study-log.js';
import {
  EvidenceFieldsSchema,
  type RejectedItem,
  boundedLine,
  oneLine,
  parseBatchOf,
  parseEvidence,
} from './submission.js';
import { type Result, err, ok } from './types.js';

/** Proposals per submission: a night's reading, not a backlog dump. */
export const MAX_PROPOSALS_PER_BATCH = 20;
/**
 * Proposals shown in one message. The rest are shown once earlier ones leave the open set, by
 * being dismissed or adopted: the weekly run does not remember what it showed.
 */
export const MAX_PROPOSALS_SHOWN = 3;
/** Evidence one proposal keeps, however often it is proposed again. */
export const MAX_EVIDENCE_PER_PROPOSAL = 20;

// ─── Slug ─────────────────────────────────────────────────────────────────────

/** Hex digits of the hash appended to a slug that had to be cut. */
const SLUG_HASH_CHARS = 6;

/**
 * The kebab-case slug a title becomes: lower-case ASCII words joined by hyphens, accents
 * dropped. Deterministic, so proposing "Eval Judges" twice is proposing one thing. A title too
 * long for MAX_PROPOSAL_SLUG_CHARS is cut at a word boundary and given a short hash of the whole
 * slug, so two long titles that share a prefix do not become one proposal.
 */
export function slugOf(title: string): Result<ProposalSlug, string> {
  const words = title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (words === '') return err('title has no letters or digits to make a slug from');
  if (words.length <= MAX_PROPOSAL_SLUG_CHARS) return ok(words as ProposalSlug);

  const room = MAX_PROPOSAL_SLUG_CHARS - SLUG_HASH_CHARS - 1;
  const cut = words.slice(0, room);
  const whole = words[room] === '-' ? cut : cut.replace(/-[^-]*$/, '');
  const prefix = (whole === '' ? cut : whole).replace(/-+$/, '');
  return ok(`${prefix}-${hash53Hex(words).slice(0, SLUG_HASH_CHARS)}` as ProposalSlug);
}

// ─── Submission ───────────────────────────────────────────────────────────────

const ItemSchema = z.object({
  title: z.string(),
  domain: z.string(),
  subdomain: z.string(),
  outcome: z.string(),
  evidence: z
    .tuple([EvidenceFieldsSchema])
    .rest(EvidenceFieldsSchema)
    .refine((all) => all.length <= MAX_EVIDENCE_PER_SUBMISSION, {
      message: `at most ${MAX_EVIDENCE_PER_SUBMISSION} evidence items`,
    }),
});

type Item = z.infer<typeof ItemSchema>;

/** The evidence of one item: all of it valid, repeated refs kept once, never empty. */
function evidenceList(item: Item): Result<TopicProposed['evidence'], string> {
  const [head, ...tail] = item.evidence;
  const first = parseEvidence(head);
  if (!first.ok) return first;
  const rest: Evidence[] = [];
  const seen = new Set([first.value.ref]);
  for (const raw of tail) {
    const next = parseEvidence(raw);
    if (!next.ok) return next;
    if (seen.has(next.value.ref)) continue;
    seen.add(next.value.ref);
    rest.push(next.value);
  }
  return ok([first.value, ...rest]);
}

/** One item → one proposal, or the reason it is refused. */
function proposalOf(
  item: Item,
  curriculum: Curriculum,
  at: string,
): Result<readonly TopicProposed[], string> {
  const title = oneLine('title', item.title, MAX_PROPOSAL_TITLE_CHARS);
  if (!title.ok) return title;
  const slug = slugOf(title.value);
  if (!slug.ok) return slug;
  if (findTopic(curriculum, slug.value) !== undefined)
    return err(`"${slug.value}" is already a topic: tag the item to it with \`signal\` instead`);

  const domain = curriculum.domains.find((d) => d.id === item.domain);
  if (domain === undefined) return err(`unknown domain "${item.domain}"`);
  if (!domain.subdomains.some((s) => s.id === item.subdomain))
    return err(`unknown subdomain "${item.subdomain}" in domain "${item.domain}"`);

  const outcome = oneLine('outcome', item.outcome, MAX_PROPOSAL_OUTCOME_CHARS);
  if (!outcome.ok) return outcome;
  const evidence = evidenceList(item);
  if (!evidence.ok) return evidence;

  return ok([
    {
      kind: 'topic-proposed',
      at,
      slug: slug.value,
      title: title.value,
      domain: item.domain,
      subdomain: item.subdomain,
      outcome: outcome.value,
      evidence: evidence.value,
    },
  ]);
}

export type ProposalBatch = Readonly<{
  events: readonly TopicProposed[];
  rejected: readonly RejectedItem[];
}>;

/**
 * Parse a proposal submission: a JSON array of `{title, domain, subdomain, outcome, evidence}`.
 * Refused whole if it is not such an array; a bad item is reported by index and the rest go
 * through. The domain and subdomain must exist and the derived slug must not already be a topic.
 */
export function parseProposalBatch(
  text: string,
  curriculum: Curriculum,
  now: Date,
): Result<ProposalBatch, string> {
  const at = now.toISOString();
  return parseBatchOf(text, {
    noun: 'proposal batch',
    shape: '{title, domain, subdomain, outcome, evidence: [{ref, source, title, takeaway}]}',
    maxItems: MAX_PROPOSALS_PER_BATCH,
    schema: ItemSchema,
    build: (item) => proposalOf(item, curriculum, at),
  });
}

// ─── The book of proposals ────────────────────────────────────────────────────

/** A piece of evidence and when it was recorded. */
export type DatedEvidence = Evidence & Readonly<{ at: string }>;

export type Proposal = Readonly<{
  slug: ProposalSlug;
  title: string;
  domain: string;
  subdomain: string;
  outcome: string;
  /** One entry per distinct `ref`, oldest first, at most MAX_EVIDENCE_PER_PROPOSAL. */
  evidence: readonly DatedEvidence[];
  firstAt: string;
  lastAt: string;
}>;

/** A proposal the user's registry now has a topic for, and that topic's slug. */
export type AdoptedProposal = Proposal & Readonly<{ topic: TopicSlug }>;

/** Every proposal on record, by what became of it. */
export type ProposalBook = Readonly<{
  /** Neither in the registry nor dismissed: still gathering evidence, or ready to show. */
  open: readonly Proposal[];
  /** Now a registry topic: its evidence counts as signals for it. */
  adopted: readonly AdoptedProposal[];
  /** Slug → why the user declined it. */
  dismissed: ReadonlyMap<ProposalSlug, string>;
}>;

/**
 * The evidence of an incoming proposal that a proposal already holding the refs in `known` would
 * keep: one entry per distinct new ref, in order, no more than the room left under
 * MAX_EVIDENCE_PER_PROPOSAL. The fold keeps exactly these and `planProposals` asks the same
 * question, so what is recorded and what is kept cannot disagree.
 */
function newEvidence<E extends Readonly<{ ref: string }>>(
  known: ReadonlySet<string>,
  incoming: readonly E[],
): readonly E[] {
  const seen = new Set(known);
  const kept: E[] = [];
  for (const x of incoming) {
    if (seen.has(x.ref) || known.size + kept.length >= MAX_EVIDENCE_PER_PROPOSAL) continue;
    seen.add(x.ref);
    kept.push(x);
  }
  return kept;
}

/**
 * Fold proposal events, in chronological order, into the book. The first proposal of a slug
 * fixes its title, domain, subdomain and outcome; later ones add evidence for refs not yet
 * seen. A dismissal is sticky; a slug in the registry is adopted whatever else happened to it.
 */
export function foldProposals(
  events: readonly (TopicProposed | ProposalDismissed)[],
  curriculum: Curriculum,
): ProposalBook {
  const proposals = new Map<ProposalSlug, Proposal>();
  const dismissed = new Map<ProposalSlug, string>();
  for (const e of events) {
    if (e.kind === 'proposal-dismissed') {
      dismissed.set(e.slug, e.reason);
      continue;
    }
    const known = proposals.get(e.slug);
    const added = newEvidence(new Set(known?.evidence.map((x) => x.ref)), e.evidence).map(
      (x): DatedEvidence => ({ ...x, at: e.at }),
    );
    proposals.set(e.slug, {
      slug: e.slug,
      title: known?.title ?? e.title,
      domain: known?.domain ?? e.domain,
      subdomain: known?.subdomain ?? e.subdomain,
      outcome: known?.outcome ?? e.outcome,
      evidence: [...(known?.evidence ?? []), ...added],
      firstAt: known?.firstAt ?? e.at,
      lastAt: e.at,
    });
  }
  const open: Proposal[] = [];
  const adopted: AdoptedProposal[] = [];
  for (const p of proposals.values()) {
    const topic = findTopic(curriculum, p.slug);
    if (topic !== undefined) adopted.push({ ...p, topic: topic.slug });
    else if (!dismissed.has(p.slug)) open.push(p);
  }
  return { open, adopted, dismissed };
}

/** The evidence of adopted proposals, as the signals the builder reads for the new topic. */
export const adoptedSignals = (book: ProposalBook): readonly SignalNoted[] =>
  book.adopted.flatMap((p) =>
    p.evidence.map(
      (e): SignalNoted => ({
        kind: 'signal-noted',
        at: e.at,
        topic: p.topic,
        ref: e.ref,
        source: e.source,
        title: e.title,
        takeaway: e.takeaway,
      }),
    ),
  );

/** How many distinct voices back a proposal; a source is counted case-insensitively. */
export const distinctSources = (p: Proposal): number =>
  new Set(p.evidence.map((e) => e.source.toLowerCase())).size;

/**
 * Open proposals with enough distinct evidence from enough distinct sources, strongest first
 * (then oldest, then by slug, so the order is total).
 */
export function dueProposals(
  book: ProposalBook,
  settings: Pick<StudySettings, 'proposalMinEvidence' | 'proposalMinSources'>,
): readonly Proposal[] {
  return book.open
    .filter(
      (p) =>
        p.evidence.length >= settings.proposalMinEvidence &&
        distinctSources(p) >= settings.proposalMinSources,
    )
    .toSorted(
      (a, b) =>
        b.evidence.length - a.evidence.length ||
        a.firstAt.localeCompare(b.firstAt) ||
        a.slug.localeCompare(b.slug),
    );
}

// ─── Recording ────────────────────────────────────────────────────────────────

/**
 * What to append: proposals that add something. One for a slug the user dismissed is dropped; one
 * that adds no evidence the fold would keep (see `newEvidence`) is a duplicate. The rest are kept
 * whole; the fold keeps only the refs it has room for.
 */
export function planProposals(
  book: ProposalBook,
  incoming: readonly TopicProposed[],
): Readonly<{ fresh: readonly TopicProposed[]; duplicates: number; dismissed: number }> {
  const refs = new Map(book.open.map((p) => [p.slug, new Set(p.evidence.map((e) => e.ref))]));
  const fresh: TopicProposed[] = [];
  let duplicates = 0;
  let dismissed = 0;
  for (const e of incoming) {
    if (book.dismissed.has(e.slug)) {
      dismissed++;
      continue;
    }
    const known = refs.get(e.slug) ?? new Set<string>();
    const kept = newEvidence(known, e.evidence);
    if (kept.length === 0) {
      duplicates++;
      continue;
    }
    refs.set(e.slug, new Set([...known, ...kept.map((x) => x.ref)]));
    fresh.push(e);
  }
  return { fresh, duplicates, dismissed };
}

export type DismissError = Readonly<{ kind: 'no-such-proposal'; slug: string }>;

/**
 * The event that dismisses an open proposal, or null when it is dismissed already (so a retry is
 * harmless). A slug that is not a proposal, or is already a topic, cannot be dismissed. The reason
 * is the user's free text relayed by a model: it is cut to what the log can hold, never refused,
 * because a dismissal should not fail for being wordy and a line the log rejects would corrupt it.
 */
export function dismissProposal(
  book: ProposalBook,
  slug: string,
  reason: string,
  now: Date,
): Result<ProposalDismissed | null, DismissError> {
  const open = book.open.find((p) => p.slug === slug);
  if (open === undefined)
    return [...book.dismissed.keys()].some((s) => s === slug)
      ? ok(null)
      : err({ kind: 'no-such-proposal', slug });
  return ok({
    kind: 'proposal-dismissed',
    at: now.toISOString(),
    slug: open.slug,
    reason: boundedLine(reason, MAX_PROPOSAL_REASON_CHARS),
  });
}

// ─── Registry entry ───────────────────────────────────────────────────────────

/**
 * The registry entry for a proposal, ready to paste into `registry.yaml`. Position in the list is
 * study order and prerequisites must come earlier, so both are left for the user. Every evidence
 * item reaches the builder as a signal once the topic exists; vault-note refs are additionally
 * listed as `sources`, because the registry's `sources` field takes vault paths, not URLs.
 */
export function registryEntryOf(p: Proposal): string {
  const vaultSources = p.evidence.map((e) => e.ref).filter((ref) => !/^https?:\/\//i.test(ref));
  const q = (s: string) => JSON.stringify(s);
  return [
    `  - slug: ${p.slug}`,
    `    title: ${q(p.title)}`,
    `    domain: ${p.domain}`,
    `    subdomain: ${p.subdomain}`,
    `    outcome: ${q(p.outcome)}`,
    '    prereqs: []',
    `    sources: [${vaultSources.map(q).join(', ')}]`,
    `    gaps: ${q(`Proposed from ${p.evidence.length} tagged items; read them as signals.`)}`,
  ].join('\n');
}
