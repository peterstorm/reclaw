// Test fixtures for the learning loop: render registries and master notes from small
// models, so tests state intent ("2 lessons, 3 cards each") instead of pasting markdown.

import type { LearningVault } from '../../orchestration/learn-command.js';
import { CURRICULUM_ROOT, REGISTRY_PATH } from '../curriculum.js';

export type TopicSpec = Readonly<{
  slug: string;
  domain?: string;
  subdomain?: string;
  prereqs?: readonly string[];
  sources?: readonly string[];
}>;

export function renderRegistry(
  topics: readonly TopicSpec[],
  settings: Readonly<Record<string, number>> = {},
): string {
  const lines = ['settings:'];
  for (const [k, v] of Object.entries(settings)) lines.push(`  ${k}: ${v}`);
  if (Object.keys(settings).length === 0) lines[0] = 'settings: {}';
  lines.push(
    'domains:',
    '  - id: ai',
    '    title: AI',
    '    subdomains:',
    '      - { id: core, title: Core }',
    '      - { id: extra, title: Extra }',
    '  - id: infra',
    '    title: Infra',
    '    subdomains:',
    '      - { id: core, title: Core }',
    'topics:',
  );
  for (const t of topics) {
    lines.push(
      `  - slug: ${t.slug}`,
      `    title: Title of ${t.slug}`,
      `    domain: ${t.domain ?? 'ai'}`,
      `    subdomain: ${t.subdomain ?? 'core'}`,
      `    outcome: Explain ${t.slug}`,
      `    prereqs: [${(t.prereqs ?? []).join(', ')}]`,
      `    sources: [${(t.sources ?? []).map((s) => JSON.stringify(s)).join(', ')}]`,
      '    gaps: none',
    );
  }
  return `${lines.join('\n')}\n`;
}

export type CardSpec = Readonly<{ id: string; lesson: number; question: string; answer: string }>;

export type NoteSpec = Readonly<{
  slug: string;
  lessons: number;
  cardsPerLesson?: number;
  cards?: readonly CardSpec[];
  minutes?: number;
}>;

export const defaultCards = (lessons: number, perLesson: number): CardSpec[] =>
  Array.from({ length: lessons * perLesson }, (_, i) => ({
    id: `c${String(i + 1).padStart(2, '0')}`,
    lesson: Math.floor(i / perLesson) + 1,
    question: `Question ${i + 1}?`,
    answer: `Answer ${i + 1}.`,
  }));

export function renderNote(spec: NoteSpec): string {
  const cards = spec.cards ?? defaultCards(spec.lessons, spec.cardsPerLesson ?? 3);
  const out = [
    '---',
    `title: Note ${spec.slug}`,
    'date: 2026-10-17',
    'tags: [learning, curriculum]',
    'curriculum:',
    `  slug: ${spec.slug}`,
    `  minutes: ${spec.minutes ?? spec.lessons * 12}`,
    '---',
    `# Note ${spec.slug}`,
    '',
  ];
  for (let l = 1; l <= spec.lessons; l++) {
    out.push(
      `## Lesson ${l} — Part ${l}`,
      '> [!example] Before you read — guess first',
      `> 1. Pretest ${l}a?`,
      `> 2. Pretest ${l}b?`,
      '',
      `Body of lesson ${l}.`,
      '',
    );
  }
  out.push('## Recall cards', '');
  for (const c of cards) {
    out.push(`> [!question]- ${c.id} · L${c.lesson} · ${c.question}`);
    for (const line of c.answer.split('\n')) out.push(`> ${line}`);
    out.push('');
  }
  out.push('## Sources', '- somewhere');
  return out.join('\n');
}

/** In-memory LearningVault fake; `files` maps vault-relative paths to contents. */
export function fakeVault(
  registry: string,
  notes: Readonly<Record<string, string>> = {},
  initialLog = '',
): LearningVault & { log: () => string } {
  let log = initialLog;
  const files: Record<string, string> = { [REGISTRY_PATH]: registry, ...notes };
  return {
    readRegistry: async () => registry,
    readNote: async (path) => files[path] ?? null,
    readLog: async () => log,
    appendLog: async (lines) => {
      if (lines.length > 0) log += `${lines.join('\n')}\n`;
    },
    sourceExists: async (path) => path in files,
    log: () => log,
  };
}

export const notePath = (slug: string, domain = 'ai') => `${CURRICULUM_ROOT}/${domain}/${slug}.md`;
