// ─── Curriculum MOCs (pure render) ────────────────────────────────────────────
//
// Domain Maps of Content are DERIVED from the registry, never hand-edited: one MOC per
// domain listing every topic under its subdomain, in study order, as a wikilink. Topics
// whose master note is not built yet render as unresolved links — Obsidian's own
// "planned" marker — so builders never touch MOCs and they cannot drift.

import { CURRICULUM_ROOT, type Curriculum, type Domain, notePathFor } from './curriculum.js';

const wikilink = (path: string, title: string) => `[[${path.replace(/\.md$/, '')}|${title}]]`;

export const domainMocPath = (domain: Pick<Domain, 'id'>): string =>
  `${CURRICULUM_ROOT}/${domain.id}/MOC.md`;

export function renderDomainMoc(curriculum: Curriculum, domain: Domain, date: string): string {
  const topics = curriculum.topics.filter((t) => t.domain === domain.id);
  const lines = [
    '---',
    `title: ${domain.title}`,
    `date: ${date}`,
    'tags: [moc, learning, curriculum]',
    'aliases: []',
    `up: "[[${CURRICULUM_ROOT}/MOC|Curriculum]]"`,
    '---',
    `# ${domain.title}`,
    '',
    `Generated from \`${CURRICULUM_ROOT}/registry.yaml\` — edit the registry, then run \`bun scripts/curriculum-mocs.ts\` in reclaw. ${topics.length} topics; the number is the global study-order position. Unresolved links are topics the curriculum builder has not written yet.`,
  ];
  for (const sub of domain.subdomains) {
    const inSub = topics.filter((t) => t.subdomain === sub.id);
    if (inSub.length === 0) continue;
    lines.push('', `## ${sub.title}`, '');
    for (const t of inSub)
      lines.push(`- **#${t.position + 1}** ${wikilink(notePathFor(t), t.title)} — ${t.outcome}`);
  }
  return `${lines.join('\n')}\n`;
}
