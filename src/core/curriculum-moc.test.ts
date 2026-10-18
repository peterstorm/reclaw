import { describe, expect, it } from 'vitest';
import { renderRegistry } from './__fixtures__/learning.js';
import { domainMocPath, renderDomainMoc } from './curriculum-moc.js';
import { parseCurriculum } from './curriculum.js';

describe('renderDomainMoc', () => {
  const parsed = parseCurriculum(
    renderRegistry([
      { slug: 'a' },
      { slug: 'b', domain: 'infra' },
      { slug: 'c', subdomain: 'extra', prereqs: ['a'] },
    ]),
  );
  if (!parsed.ok) throw new Error(parsed.error.join());
  const curriculum = parsed.value;
  const ai = curriculum.domains[0];
  if (ai === undefined) throw new Error('fixture has no domain');

  it('lists only the domain’s topics, grouped by subdomain, numbered by global position', () => {
    const moc = renderDomainMoc(curriculum, ai, '2026-10-17');
    expect(moc).toContain(
      '## Core\n\n- **#1** [[learning/curriculum/ai/a|Title of a]] — Explain a',
    );
    expect(moc).toContain('## Extra\n\n- **#3** [[learning/curriculum/ai/c|Title of c]]');
    expect(moc).not.toContain('Title of b');
    expect(moc).toMatch(/^---\ntitle: AI\ndate: 2026-10-17\n/);
  });

  it('places the MOC inside the domain folder', () => {
    expect(domainMocPath(ai)).toBe('learning/curriculum/ai/MOC.md');
  });
});
