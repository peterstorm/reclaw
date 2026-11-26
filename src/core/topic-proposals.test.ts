import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { renderRegistry } from './__fixtures__/learning.js';
import { type Curriculum, parseCurriculum } from './curriculum.js';
import {
  type Evidence,
  MAX_PROPOSAL_REASON_CHARS,
  type ProposalDismissed,
  type ProposalSlug,
  type TopicProposed,
  serializeWritable,
} from './study-log.js';
import {
  MAX_EVIDENCE_PER_PROPOSAL,
  type Proposal,
  type ProposalBook,
  adoptedSignals,
  dismissProposal,
  distinctSources,
  dueProposals,
  foldProposals,
  parseProposalBatch,
  planProposals,
  registryEntryOf,
  slugOf,
} from './topic-proposals.js';

const NOW = new Date('2026-11-25T22:00:00.000Z');
const settings = { proposalMinEvidence: 3, proposalMinSources: 2 };

const load = (slugs: readonly string[]): Curriculum => {
  const parsed = parseCurriculum(renderRegistry(slugs.map((slug) => ({ slug }))));
  if (!parsed.ok) throw new Error(parsed.error.join('; '));
  return parsed.value;
};
const curriculum = load(['a', 'b']);

const evidence = (n: number, source = 'Source One'): Evidence => ({
  ref: `https://example.com/${n}`,
  source,
  title: `Item ${n}`,
  takeaway: 'Says a thing.',
});

const item = (over: Record<string, unknown> = {}) => ({
  title: 'LLM Judge Calibration',
  domain: 'ai',
  subdomain: 'core',
  outcome: 'Calibrate an LLM judge against human labels.',
  evidence: [evidence(1)],
  ...over,
});

const parse = (items: readonly unknown[], c = curriculum) =>
  parseProposalBatch(JSON.stringify(items), c, NOW);

const parsed = (items: readonly unknown[]) => {
  const result = parse(items);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

const proposed = (
  title: string,
  ev: readonly Evidence[],
  at = '2026-11-20T12:00:00.000Z',
): TopicProposed => {
  const [first, ...rest] = ev;
  if (first === undefined) throw new Error('evidence needed');
  const slug = slugOf(title);
  if (!slug.ok) throw new Error(slug.error);
  return {
    kind: 'topic-proposed',
    at,
    slug: slug.value,
    title,
    domain: 'ai',
    subdomain: 'core',
    outcome: 'An outcome.',
    evidence: [first, ...rest],
  };
};

const dismissed = (slug: string, at = '2026-11-21T12:00:00.000Z'): ProposalDismissed => ({
  kind: 'proposal-dismissed',
  at,
  slug: slug as ProposalSlug,
  reason: 'not for me',
});

describe('slugOf', () => {
  it('lower-cases, drops accents and joins words with hyphens', () => {
    expect(slugOf('Eval Judges & Calibration')).toEqual({
      ok: true,
      value: 'eval-judges-calibration',
    });
    expect(slugOf('  Café — Évals!! ')).toEqual({ ok: true, value: 'cafe-evals' });
    expect(slugOf('naïve  Bayes 2.0')).toEqual({ ok: true, value: 'naive-bayes-2-0' });
  });

  it('refuses a title with nothing to make a slug from', () => {
    for (const bad of ['', '   ', '!!!', '—·—'])
      expect(slugOf(bad).ok, JSON.stringify(bad)).toBe(false);
  });

  it('cuts a long title at a word boundary and appends a hash of the whole slug', () => {
    const slug = slugOf(`${'word '.repeat(30)}end`);
    expect(slug).toMatchObject({ ok: true });
    if (slug.ok) {
      expect(slug.value.length).toBeLessThanOrEqual(60);
      const words = slug.value.split('-');
      expect(words.slice(0, -1).every((w) => w === 'word')).toBe(true);
      expect(words.at(-1)).toMatch(/^[0-9a-f]{6}$/);
    }
    const oneWord = slugOf('x'.repeat(100));
    expect(oneWord).toMatchObject({ ok: true });
    if (oneWord.ok) expect(oneWord.value).toMatch(/^x{53}-[0-9a-f]{6}$/);
  });

  it('keeps two long titles that share a prefix apart', () => {
    const prefix = 'retrieval augmented generation evaluation harness for production assistants';
    const a = slugOf(`${prefix} part one`);
    const b = slugOf(`${prefix} part two`);
    expect(a.ok && b.ok && a.value !== b.value).toBe(true);
  });

  it('always yields a valid, bounded, idempotent slug (property)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (title) => {
        const slug = slugOf(title);
        if (!slug.ok) return;
        expect(slug.value).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
        expect(slug.value.length).toBeLessThanOrEqual(60);
        expect(slugOf(slug.value)).toEqual(slug);
      }),
    );
  });
});

describe('parseProposalBatch', () => {
  it('turns an item into one proposal stamped with the clock and a derived slug', () => {
    const { events, rejected } = parsed([item()]);
    expect(rejected).toEqual([]);
    expect(events).toEqual([
      {
        kind: 'topic-proposed',
        at: NOW.toISOString(),
        slug: 'llm-judge-calibration',
        title: 'LLM Judge Calibration',
        domain: 'ai',
        subdomain: 'core',
        outcome: 'Calibrate an LLM judge against human labels.',
        evidence: [evidence(1)],
      },
    ]);
  });

  it('keeps a repeated ref once, normalises refs and collapses whitespace', () => {
    const { events } = parsed([
      item({
        evidence: [
          {
            ...evidence(1),
            ref: 'https://example.com/1?utm_source=rss#x',
            takeaway: ' One\n line ',
          },
          evidence(1),
          evidence(2),
        ],
      }),
    ]);
    expect(events[0]?.evidence.map((e) => e.ref)).toEqual([
      'https://example.com/1',
      'https://example.com/2',
    ]);
    expect(events[0]?.evidence[0]?.takeaway).toBe('One line');
  });

  it('rejects a bad item by index and records the good ones', () => {
    const { events, rejected } = parsed([
      item(),
      item({ domain: 'nope' }),
      item({ subdomain: 'nope' }),
      item({ domain: 'infra', subdomain: 'extra' }),
      item({ title: 'a' }),
      item({ title: '!!!' }),
      item({ outcome: '  ' }),
      item({ evidence: [] }),
      item({ evidence: Array.from({ length: 6 }, (_, i) => evidence(i)) }),
      item({ evidence: [{ ...evidence(1), ref: 'ftp://nope' }] }),
      item({ evidence: [{ ...evidence(1), takeaway: 'x'.repeat(601) }] }),
      'not an object',
      item({ title: 'Another One' }),
    ]);
    expect(events.map((e) => e.slug)).toEqual(['llm-judge-calibration', 'another-one']);
    expect(rejected.map((r) => r.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(rejected[0]?.reason).toContain('unknown domain');
    expect(rejected[3]?.reason).toContain('already a topic'); // title "a" is the slug of topic a
  });

  it('refuses to propose what is already a topic, pointing at signal', () => {
    const { events, rejected } = parsed([item({ title: 'A' })]);
    expect(events).toEqual([]);
    expect(rejected[0]?.reason).toContain('already a topic');
  });

  it('refuses a submission that is not a bounded JSON array', () => {
    for (const bad of ['', 'nope', '{}', '[]', JSON.stringify(Array(21).fill(item()))])
      expect(parseProposalBatch(bad, curriculum, NOW).ok, bad.slice(0, 20)).toBe(false);
  });

  it('never throws and rejects each bad item once, whatever it is given (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.jsonValue(), { minLength: 1, maxLength: 8 }), (items) => {
        const result = parse(items);
        expect(result.ok).toBe(true);
        if (result.ok) {
          const indices = result.value.rejected.map((r) => r.index);
          expect(new Set(indices).size).toBe(indices.length);
          expect(result.value.events.length + indices.length).toBeLessThanOrEqual(items.length);
        }
      }),
    );
  });
});

describe('foldProposals', () => {
  const fold = (events: readonly (TopicProposed | ProposalDismissed)[], c = curriculum) =>
    foldProposals(events, c);

  it('lets the first proposal fix the metadata and later ones add evidence by ref', () => {
    const first = proposed('Judge Calibration', [evidence(1)], '2026-11-20T12:00:00.000Z');
    const later: TopicProposed = {
      ...first,
      at: '2026-11-22T12:00:00.000Z',
      title: 'Retitled',
      outcome: 'Different.',
      evidence: [evidence(1), evidence(2, 'Other')],
    };
    const [p] = fold([first, later]).open;
    expect(p).toMatchObject({
      slug: 'judge-calibration',
      title: 'Judge Calibration',
      outcome: 'An outcome.',
      firstAt: first.at,
      lastAt: later.at,
    });
    expect(p?.evidence.map((e) => [e.ref.slice(-1), e.at])).toEqual([
      ['1', first.at],
      ['2', later.at],
    ]);
  });

  // The count decides when a proposal is shown, so one item repeated inside a single event (a
  // log the CLI did not write) must not count twice.
  it('counts a ref once even when one event repeats it', () => {
    const repeated = proposed('Judge Calibration', [evidence(1), evidence(1), evidence(2)]);
    expect(fold([repeated]).open[0]?.evidence.map((e) => e.ref)).toEqual([
      'https://example.com/1',
      'https://example.com/2',
    ]);
  });

  it('keeps at most MAX_EVIDENCE_PER_PROPOSAL items', () => {
    const events = Array.from({ length: 30 }, (_, i) => proposed('Big One', [evidence(i)]));
    expect(fold(events).open[0]?.evidence).toHaveLength(MAX_EVIDENCE_PER_PROPOSAL);
  });

  it('a dismissal is sticky, even for evidence that arrives afterwards', () => {
    const book = fold([
      proposed('Judge Calibration', [evidence(1)]),
      dismissed('judge-calibration'),
      proposed('Judge Calibration', [evidence(2)], '2026-11-23T12:00:00.000Z'),
    ]);
    expect(book.open).toEqual([]);
    expect([...book.dismissed.keys()]).toEqual(['judge-calibration']);
  });

  it('adopts a proposal once its slug is a registry topic, whatever else happened to it', () => {
    const events = [
      proposed('Judge Calibration', [evidence(1), evidence(2)]),
      dismissed('judge-calibration'),
    ];
    const book = fold(events, load(['a', 'b', 'judge-calibration']));
    expect(book.open).toEqual([]);
    expect(book.adopted.map((p) => p.slug)).toEqual(['judge-calibration']);
  });

  it('turns an adopted proposal’s evidence into signals for the new topic', () => {
    const adopted = load(['a', 'judge-calibration']);
    const book = fold([proposed('Judge Calibration', [evidence(1), evidence(2)])], adopted);
    expect(adoptedSignals(book)).toEqual([
      expect.objectContaining({
        kind: 'signal-noted',
        topic: 'judge-calibration',
        ref: 'https://example.com/1',
        at: '2026-11-20T12:00:00.000Z',
      }),
      expect.objectContaining({ topic: 'judge-calibration', ref: 'https://example.com/2' }),
    ]);
    expect(adoptedSignals(fold([proposed('Judge Calibration', [evidence(1)])]))).toEqual([]);
  });
});

describe('dueProposals', () => {
  const book = (...proposals: Proposal[]): ProposalBook => ({
    open: proposals,
    adopted: [],
    dismissed: new Map(),
  });
  const make = (slug: string, sources: readonly string[], firstAt = '2026-11-20T00:00:00.000Z') =>
    ({
      slug: slug as ProposalSlug,
      title: slug,
      domain: 'ai',
      subdomain: 'core',
      outcome: 'o',
      evidence: sources.map((source, i) => ({ ...evidence(i), source, at: firstAt })),
      firstAt,
      lastAt: firstAt,
    }) satisfies Proposal;

  it('needs enough distinct items from enough distinct sources, sources compared case-insensitively', () => {
    const due = (p: Proposal) => dueProposals(book(p), settings).length === 1;
    expect(due(make('a', ['X', 'Y', 'Z']))).toBe(true);
    expect(due(make('a', ['X', 'Y']))).toBe(false);
    expect(due(make('a', ['X', 'x', 'X']))).toBe(false);
    expect(due(make('a', ['X', 'x', 'Y']))).toBe(true);
  });

  it('counts a source once however it is capitalised, and is the count the message shows', () => {
    expect(distinctSources(make('a', ['X', 'x', 'Y', 'X']))).toBe(2);
    expect(distinctSources(make('a', []))).toBe(0);
  });

  it('orders by most evidence, then oldest, then slug', () => {
    const order = dueProposals(
      book(
        make('c', ['X', 'Y', 'Z']),
        make('b', ['X', 'Y', 'Z', 'W']),
        make('a', ['X', 'Y', 'Z']),
        make('d', ['X', 'Y', 'Z'], '2026-11-01T00:00:00.000Z'),
      ),
      settings,
    ).map((p) => p.slug);
    expect(order).toEqual(['b', 'd', 'a', 'c']);
  });
});

describe('planProposals', () => {
  const empty: ProposalBook = { open: [], adopted: [], dismissed: new Map() };
  const bookOf = (events: readonly (TopicProposed | ProposalDismissed)[]) =>
    foldProposals(events, curriculum);

  it('keeps proposals that add evidence and counts the rest', () => {
    const known = bookOf([proposed('Judge Calibration', [evidence(1)]), dismissed('old-idea')]);
    const plan = planProposals(known, [
      proposed('Judge Calibration', [evidence(1)]), // nothing new
      proposed('Judge Calibration', [evidence(1), evidence(2)]), // one new
      proposed('Old Idea', [evidence(3)]), // dismissed
      proposed('Fresh Idea', [evidence(4)]),
      proposed('Fresh Idea', [evidence(4)]), // repeats the one just before it
    ]);
    expect(plan.fresh.map((e) => e.slug)).toEqual(['judge-calibration', 'fresh-idea']);
    expect(plan).toMatchObject({ duplicates: 2, dismissed: 1 });
  });

  // The fold keeps at most MAX_EVIDENCE_PER_PROPOSAL refs; a plan that judged "new" against a
  // different rule would append the same resubmission forever, changing nothing.
  it('counts a resubmission to a proposal already at the evidence cap as a duplicate', () => {
    const full = bookOf(
      Array.from({ length: MAX_EVIDENCE_PER_PROPOSAL }, (_, i) =>
        proposed('Big One', [evidence(i)]),
      ),
    );
    expect(full.open[0]?.evidence).toHaveLength(MAX_EVIDENCE_PER_PROPOSAL);
    const overflow = proposed('Big One', [evidence(MAX_EVIDENCE_PER_PROPOSAL + 1)]);
    expect(planProposals(full, [overflow, overflow])).toMatchObject({ fresh: [], duplicates: 2 });
    // One slot left: the first new ref fits, a second event adds nothing the fold would keep.
    const almost = bookOf(
      Array.from({ length: MAX_EVIDENCE_PER_PROPOSAL - 1 }, (_, i) =>
        proposed('Big One', [evidence(i)]),
      ),
    );
    const plan = planProposals(almost, [
      proposed('Big One', [evidence(100)]),
      proposed('Big One', [evidence(101)]),
    ]);
    expect(plan).toMatchObject({ duplicates: 1 });
    expect(plan.fresh).toHaveLength(1);
  });

  it('is idempotent: recording what a plan kept makes the same submission add nothing (property)', () => {
    const title = fc.constantFrom('Alpha Topic', 'Beta Topic', 'Gamma Topic');
    // Enough distinct refs per title that a proposal can saturate at the evidence cap.
    const ev = fc.array(fc.integer({ min: 0, max: 40 }), { minLength: 1, maxLength: 5 });
    fc.assert(
      fc.property(fc.array(fc.tuple(title, ev), { maxLength: 30 }), (items) => {
        const batch = items.map(([t, ns]) =>
          proposed(
            t,
            ns.map((n) => evidence(n)),
          ),
        );
        const once = planProposals(empty, batch);
        const book = bookOf(once.fresh);
        expect(planProposals(book, batch).fresh).toEqual([]);
        expect(once.fresh.length + once.duplicates).toBe(batch.length);
      }),
    );
  });
});

describe('dismissProposal', () => {
  const book = foldProposals(
    [
      proposed('Judge Calibration', [evidence(1)]),
      proposed('Other', [evidence(2)]),
      dismissed('other'),
    ],
    curriculum,
  );

  it('dismisses an open proposal, is a no-op when already dismissed, and refuses an unknown one', () => {
    expect(dismissProposal(book, 'judge-calibration', 'meh', NOW)).toEqual({
      ok: true,
      value: {
        kind: 'proposal-dismissed',
        at: NOW.toISOString(),
        slug: 'judge-calibration',
        reason: 'meh',
      },
    });
    expect(dismissProposal(book, 'other', '', NOW)).toEqual({ ok: true, value: null });
    expect(dismissProposal(book, 'a', '', NOW)).toEqual({
      ok: false,
      error: { kind: 'no-such-proposal', slug: 'a' },
    });
  });

  // The reason is free text a model relays from the user's reply. The log's reader refuses a line
  // whose reason is over its cap, which would make every later command fail: the writer must
  // never produce one, however long or odd the reason.
  it('always yields an event the study log parses, whatever the reason (property)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 1500 }), (reason) => {
        const result = dismissProposal(book, 'judge-calibration', reason, NOW);
        expect(result.ok).toBe(true);
        if (!(result.ok && result.value !== null)) return;
        expect(result.value.reason.length).toBeLessThanOrEqual(MAX_PROPOSAL_REASON_CHARS);
        expect(serializeWritable([result.value]).ok).toBe(true);
      }),
    );
  });

  it('cuts a long reason with an ellipsis instead of refusing the dismissal', () => {
    const result = dismissProposal(
      book,
      'judge-calibration',
      `not for me ${'because '.repeat(80)}`,
      NOW,
    );
    expect(result).toMatchObject({ ok: true, value: { kind: 'proposal-dismissed' } });
    if (result.ok && result.value !== null) {
      expect(result.value.reason.startsWith('not for me because')).toBe(true);
      expect(result.value.reason.endsWith('…')).toBe(true);
    }
  });
});

describe('registryEntryOf', () => {
  const proposal = (title: string, vault: readonly string[] = []): Proposal => ({
    slug: 'some-topic' as ProposalSlug,
    title,
    domain: 'ai',
    subdomain: 'core',
    outcome: 'Do "quoted" things: carefully # not a comment.',
    evidence: [
      ...vault.map((ref, i) => ({ ...evidence(i), ref, at: '2026-11-20T00:00:00.000Z' })),
      { ...evidence(99), at: '2026-11-20T00:00:00.000Z' },
    ],
    firstAt: '2026-11-20T00:00:00.000Z',
    lastAt: '2026-11-20T00:00:00.000Z',
  });

  it('is a registry entry: it parses, survives awkward text and lists vault notes as sources', () => {
    const entry = registryEntryOf(
      proposal('Judges: "calibration" & #bias', ['media/instagram/h/abc.md']),
    );
    expect(parseYaml(entry)).toEqual([
      {
        slug: 'some-topic',
        title: 'Judges: "calibration" & #bias',
        domain: 'ai',
        subdomain: 'core',
        outcome: 'Do "quoted" things: carefully # not a comment.',
        prereqs: [],
        sources: ['media/instagram/h/abc.md'],
        gaps: 'Proposed from 2 tagged items; read them as signals.',
      },
    ]);
  });

  it('pasted into a registry it makes a topic, which adopts the proposal', () => {
    const p = proposal('Judge Calibration');
    const registry = `${renderRegistry([{ slug: 'a' }])}${registryEntryOf({ ...p, slug: 'judge-calibration' as ProposalSlug })}\n`;
    const next = parseCurriculum(registry);
    expect(next).toMatchObject({ ok: true });
    if (next.ok) expect(next.value.bySlug.has('judge-calibration' as never)).toBe(true);
  });

  it('keeps any title intact through YAML (property)', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 60 }), (title) => {
        const [entry] = parseYaml(registryEntryOf(proposal(title))) as { title: string }[];
        expect(entry?.title).toBe(title);
      }),
    );
  });
});
