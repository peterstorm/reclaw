// ─── Curriculum ───────────────────────────────────────────────────────────────
//
// The curriculum registry (`learning/curriculum/registry.yaml` in the vault) is the
// single source of truth for WHAT can be studied and in WHICH order. List position is
// study order. Parsing enforces the invariants every downstream decision relies on:
// unique slugs, declared domains/subdomains, and prerequisites that exist and appear
// EARLIER in the list (which also makes the prerequisite graph acyclic). A `Curriculum`
// value is therefore proof that reading topics in order never violates a prerequisite.

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { type Result, err, ok } from './types.js';

export type TopicSlug = string & { readonly __brand: 'TopicSlug' };
export type DomainId = string & { readonly __brand: 'DomainId' };

export type Subdomain = Readonly<{ id: string; title: string }>;

export type Domain = Readonly<{
  id: DomainId;
  title: string;
  subdomains: readonly Subdomain[];
}>;

export type Topic = Readonly<{
  slug: TopicSlug;
  title: string;
  domain: DomainId;
  subdomain: string;
  outcome: string;
  prereqs: readonly TopicSlug[];
  /** Vault-relative paths, or absolute / `~/` paths outside the vault, that the note consolidates. */
  sources: readonly string[];
  /** What the vault lacks — where external research must fill in. */
  gaps: string;
  /** 0-based study-order index. */
  position: number;
}>;

/** Tunables for the study loop; live in the registry so they change without a deploy. */
export type StudySettings = Readonly<{
  /** Cards per recall round. */
  roundSize: number;
  /** Max cards seen for the first time per rolling 24h. */
  newCardsPerDay: number;
  /** An asked-but-unanswered card is not re-asked for this many hours. */
  pendingHours: number;
  /** Built-but-unread topics to keep ahead of the reader before the builder idles. */
  buildBuffer: number;
  /** Due-card count above which the lesson prompt suggests catching up on recall first. */
  backlogThreshold: number;
  /** FSRS target retention (0.7–0.97). */
  requestRetention: number;
  /** Days between Feynman checks of the same topic. */
  feynmanCooldownDays: number;
}>;

export type Curriculum = Readonly<{
  domains: readonly Domain[];
  topics: readonly Topic[];
  bySlug: ReadonlyMap<TopicSlug, Topic>;
  settings: StudySettings;
}>;

export const CURRICULUM_ROOT = 'learning/curriculum';
export const REGISTRY_PATH = `${CURRICULUM_ROOT}/registry.yaml`;
export const STUDY_LOG_PATH = `${CURRICULUM_ROOT}/.state/study-log.jsonl`;

/** Where a topic's master note lives, vault-relative. */
export const notePathFor = (topic: Pick<Topic, 'domain' | 'slug'>): string =>
  `${CURRICULUM_ROOT}/${topic.domain}/${topic.slug}.md`;

// ─── Schema ───────────────────────────────────────────────────────────────────

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const SettingsSchema = z
  .object({
    roundSize: z.number().int().min(1).max(10).default(3),
    newCardsPerDay: z.number().int().min(0).max(50).default(8),
    pendingHours: z.number().positive().max(72).default(8),
    buildBuffer: z.number().int().min(1).max(20).default(3),
    backlogThreshold: z.number().int().min(1).default(30),
    requestRetention: z.number().min(0.7).max(0.97).default(0.9),
    feynmanCooldownDays: z.number().int().min(1).default(21),
  })
  .default({});

const RegistrySchema = z.object({
  settings: SettingsSchema,
  domains: z
    .array(
      z.object({
        id: z.string().regex(KEBAB),
        title: z.string().min(1),
        subdomains: z
          .array(z.object({ id: z.string().regex(KEBAB), title: z.string().min(1) }))
          .min(1),
      }),
    )
    .min(1),
  topics: z
    .array(
      z.object({
        slug: z.string().regex(KEBAB, 'slug must be kebab-case'),
        title: z.string().min(1),
        domain: z.string().min(1),
        subdomain: z.string().min(1),
        outcome: z.string().min(1),
        prereqs: z.array(z.string()).default([]),
        sources: z.array(z.string().min(1)).default([]),
        gaps: z.string().default(''),
      }),
    )
    .min(1),
});

// ─── Parser (pure) ────────────────────────────────────────────────────────────

export function parseCurriculum(yamlText: string): Result<Curriculum, readonly string[]> {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (e) {
    return err([`registry YAML parse error: ${e instanceof Error ? e.message : String(e)}`]);
  }
  const parsed = RegistrySchema.safeParse(raw);
  if (!parsed.success) {
    return err(parsed.error.issues.map((i) => `registry ${i.path.join('.')}: ${i.message}`));
  }

  const errors: string[] = [];
  const domains: Domain[] = parsed.data.domains.map((d) => ({
    id: d.id as DomainId,
    title: d.title,
    subdomains: d.subdomains,
  }));
  const domainById = new Map(domains.map((d) => [d.id as string, d]));
  if (domainById.size !== domains.length) errors.push('registry: duplicate domain id');

  const positionBySlug = new Map<string, number>();
  parsed.data.topics.forEach((t, i) => {
    if (positionBySlug.has(t.slug)) errors.push(`topic ${t.slug}: duplicate slug`);
    else positionBySlug.set(t.slug, i);
  });

  const topics: Topic[] = parsed.data.topics.map((t, position) => {
    const domain = domainById.get(t.domain);
    if (domain === undefined) {
      errors.push(`topic ${t.slug}: unknown domain "${t.domain}"`);
    } else if (!domain.subdomains.some((s) => s.id === t.subdomain)) {
      errors.push(`topic ${t.slug}: unknown subdomain "${t.subdomain}" in domain "${t.domain}"`);
    }
    for (const p of t.prereqs) {
      const pPos = positionBySlug.get(p);
      if (pPos === undefined) errors.push(`topic ${t.slug}: unknown prereq "${p}"`);
      else if (pPos >= position)
        errors.push(`topic ${t.slug}: prereq "${p}" must appear earlier in study order`);
    }
    return {
      slug: t.slug as TopicSlug,
      title: t.title,
      domain: t.domain as DomainId,
      subdomain: t.subdomain,
      outcome: t.outcome,
      prereqs: t.prereqs as TopicSlug[],
      sources: t.sources,
      gaps: t.gaps,
      position,
    };
  });

  if (errors.length > 0) return err(errors);
  return ok({
    domains,
    topics,
    bySlug: new Map(topics.map((t) => [t.slug, t])),
    settings: parsed.data.settings,
  });
}
