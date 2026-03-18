import { describe, expect, it } from 'vitest';
import {
  buildHubNote,
  buildSourceNote,
  buildQANote,
  buildEmergencyNote,
  buildAllVaultNotes,
} from './vault-content.js';
import type { ResearchContext, QualityResult, SourceMeta, ChatResponse } from './research-types.js';
import type { TopicSlug } from './topic-slug.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const makeTopicSlug = (s: string) => s as TopicSlug;

const sources: readonly SourceMeta[] = [
  {
    id: 'src-1',
    title: 'First Article',
    url: 'https://example.com/first',
    sourceType: 'web',
  },
  {
    id: 'src-2',
    title: 'YouTube Tutorial',
    url: 'https://youtube.com/watch?v=abc',
    sourceType: 'youtube',
  },
];

const chatResponse = (text: string, citations: number[] = []): ChatResponse => ({
  text,
  citations,
  rawData: null,
});

const makeContext = (overrides: Partial<ResearchContext> = {}): ResearchContext => ({
  topic: 'Artificial Intelligence',
  prompt: null,
  topicSlug: makeTopicSlug('artificial-intelligence'),
  sourceHints: [],
  chatId: 12345,
  notebookId: 'notebook-abc',
  searchSessionId: null,
  discoveredWebSources: [],
  sourceUrlById: {},
  sources,
  questions: ['What is AI?', 'How does ML work?'],
  answers: {
    'What is AI?': chatResponse('AI is the simulation of human intelligence [1].', [1]),
    'How does ML work?': chatResponse('ML uses statistical models [2].', [2]),
  },
  skippedQuestions: [],
  resolvedNotes: [],
  hubPath: null,
  retries: {},
  lastError: null,
  trace: [],
  chatsUsed: 2,
  startedAt: '2026-03-04T10:00:00.000Z',
  generateAudio: false,
  generateVideo: false,
  artifacts: [],
  artifactFailures: [],
  ...overrides,
});

const goodQuality: QualityResult = { grade: 'good', warnings: [] };
const partialQuality: QualityResult = {
  grade: 'partial',
  warnings: ['Less than 50% of questions answered.'],
};
const poorQuality: QualityResult = {
  grade: 'poor',
  warnings: ['Less than 50% of questions answered.', 'Only 1 source cited.'],
};

// ─── buildHubNote ──────────────────────────────────────────────────────────────

describe('buildHubNote', () => {
  describe('FR-041: hub note structure', () => {
    it('returns a VaultNote with relativePath under reclaw/research/{slug}/_index.md', () => {
      const note = buildHubNote(makeContext(), goodQuality);
      expect(note.relativePath).toBe('reclaw/research/artificial-intelligence/_index.md');
    });

    it('contains the topic title in frontmatter', () => {
      const note = buildHubNote(makeContext(), goodQuality);
      expect(note.content).toContain("title: 'Artificial Intelligence'");
    });

    it('contains the research date in frontmatter', () => {
      const note = buildHubNote(makeContext(), goodQuality);
      expect(note.content).toContain('date: 2026-03-04');
    });

    it('contains the quality grade in frontmatter', () => {
      const note = buildHubNote(makeContext(), goodQuality);
      expect(note.content).toContain('quality: good');
    });

    it('includes links to all source notes', () => {
      const note = buildHubNote(makeContext(), goodQuality);
      expect(note.content).toContain('[[First Article]]');
      expect(note.content).toContain('[[YouTube Tutorial]]');
    });

    it('includes links to all Q&A notes', () => {
      const note = buildHubNote(makeContext(), goodQuality);
      // Q&A link uses the sanitized question as filename (? is stripped from filenames)
      expect(note.content).toContain('[[What is AI]]');
      expect(note.content).toContain('[[How does ML work]]');
    });

    it('includes quality grade in content body', () => {
      const note = buildHubNote(makeContext(), goodQuality);
      expect(note.content).toContain('good');
    });

    it('shows warnings section for partial quality', () => {
      const note = buildHubNote(makeContext(), partialQuality);
      expect(note.content).toContain('Quality Warnings');
      expect(note.content).toContain('Less than 50% of questions answered.');
    });

    it('shows warnings section for poor quality', () => {
      const note = buildHubNote(makeContext(), poorQuality);
      expect(note.content).toContain('Quality Warnings');
      expect(note.content).toContain('Only 1 source cited.');
    });

    it('does not show warnings section for good quality', () => {
      const note = buildHubNote(makeContext(), goodQuality);
      expect(note.content).not.toContain('Quality Warnings');
    });

    it('has YAML frontmatter delimiters', () => {
      const note = buildHubNote(makeContext(), goodQuality);
      expect(note.content).toMatch(/^---\n/);
      expect(note.content).toMatch(/\n---\n/);
    });

    it('shows placeholder when no sources ingested', () => {
      const ctx = makeContext({ sources: [] });
      const note = buildHubNote(ctx, goodQuality);
      expect(note.content).toContain('_No sources ingested._');
    });

    it('shows placeholder when no questions answered', () => {
      const ctx = makeContext({ answers: {} });
      const note = buildHubNote(ctx, goodQuality);
      expect(note.content).toContain('_No questions answered._');
    });
  });
});

// ─── buildSourceNote ──────────────────────────────────────────────────────────

describe('buildSourceNote', () => {
  const source = sources[0]!;
  const topicSlug = makeTopicSlug('artificial-intelligence');
  const hubPath = 'reclaw/research/artificial-intelligence/_index.md';
  const passageAnchors = '## Passage 1';
  const researchDate = '2026-03-04';
  const notebookId = 'notebook-abc';

  describe('FR-042: source note frontmatter', () => {
    it('returns a VaultNote with relativePath under reclaw/research/{slug}/Sources/', () => {
      const note = buildSourceNote(source, topicSlug, hubPath, passageAnchors, researchDate, notebookId);
      expect(note.relativePath).toBe(
        'reclaw/research/artificial-intelligence/Sources/First Article.md',
      );
    });

    it('contains source_type in frontmatter', () => {
      const note = buildSourceNote(source, topicSlug, hubPath, passageAnchors, researchDate, notebookId);
      expect(note.content).toContain('source_type: web');
    });

    it('contains url in frontmatter (single-quoted for YAML safety)', () => {
      const note = buildSourceNote(source, topicSlug, hubPath, passageAnchors, researchDate, notebookId);
      expect(note.content).toContain("url: 'https://example.com/first'");
    });

    it('contains notebook_id in frontmatter using notebookId parameter', () => {
      const note = buildSourceNote(source, topicSlug, hubPath, passageAnchors, researchDate, notebookId);
      expect(note.content).toContain("notebook_id: 'notebook-abc'");
    });

    it('contains date in frontmatter', () => {
      const note = buildSourceNote(source, topicSlug, hubPath, passageAnchors, researchDate, notebookId);
      // date should be present in the format YYYY-MM-DD
      expect(note.content).toMatch(/date: \d{4}-\d{2}-\d{2}/);
    });

    it('contains exact researchDate passed in', () => {
      const note = buildSourceNote(source, topicSlug, hubPath, passageAnchors, '2026-01-15', notebookId);
      expect(note.content).toContain('date: 2026-01-15');
    });

    it('contains topic tag in frontmatter', () => {
      const note = buildSourceNote(source, topicSlug, hubPath, passageAnchors, researchDate, notebookId);
      expect(note.content).toContain('artificial-intelligence');
    });

    it('contains up link in frontmatter (single-quoted for YAML safety)', () => {
      const note = buildSourceNote(source, topicSlug, hubPath, passageAnchors, researchDate, notebookId);
      expect(note.content).toContain(`up: '${hubPath}'`);
    });

    it('has YAML frontmatter delimiters', () => {
      const note = buildSourceNote(source, topicSlug, hubPath, passageAnchors, researchDate, notebookId);
      expect(note.content).toMatch(/^---\n/);
      expect(note.content).toMatch(/\n---\n/);
    });

    it('safely quotes url with # fragment', () => {
      const fragmentSource: SourceMeta = {
        id: 'frag',
        title: 'Fragment Article',
        url: 'https://example.com/page#section',
        sourceType: 'web',
      };
      const note = buildSourceNote(fragmentSource, topicSlug, hubPath, '', researchDate, notebookId);
      // The # must be inside quotes, not treated as YAML comment
      expect(note.content).toContain("url: 'https://example.com/page#section'");
    });
  });

  describe('FR-033: passage anchors', () => {
    it('includes passage anchors in the note body', () => {
      const note = buildSourceNote(source, topicSlug, hubPath, '## Passage 1\n\n## Passage 3', researchDate, notebookId);
      expect(note.content).toContain('## Passage 1');
      expect(note.content).toContain('## Passage 3');
    });

    it('shows placeholder when no passage anchors provided', () => {
      const note = buildSourceNote(source, topicSlug, hubPath, '', researchDate, notebookId);
      expect(note.content).toContain('_No passages cited._');
    });
  });

  describe('wikilink back to hub', () => {
    it('contains disambiguated wikilink to hub note', () => {
      const note = buildSourceNote(source, topicSlug, hubPath, passageAnchors, researchDate, notebookId);
      expect(note.content).toContain('[[artificial-intelligence/_index|artificial-intelligence]]');
    });
  });

  describe('youtube source type', () => {
    it('sets source_type to youtube for YouTube sources', () => {
      const ytSource = sources[1]!;
      const note = buildSourceNote(ytSource, topicSlug, hubPath, '', researchDate, notebookId);
      expect(note.content).toContain('source_type: youtube');
    });
  });

  describe('title sanitization', () => {
    it('sanitizes title with special characters in filename', () => {
      const specialSource: SourceMeta = {
        id: 'special',
        title: 'Source: The [Best] Guide|Ever',
        url: 'https://example.com',
        sourceType: 'web',
      };
      const note = buildSourceNote(specialSource, topicSlug, hubPath, '', researchDate, notebookId);
      // Filename should not contain illegal characters
      expect(note.relativePath).not.toMatch(/[[\]|#^:*?"<>]/);
    });
  });
});

// ─── buildQANote ──────────────────────────────────────────────────────────────

describe('buildQANote', () => {
  const question = 'What is artificial intelligence?';
  const resolvedAnswer =
    'AI is the simulation of human intelligence [[First Article#Passage 1]].';
  const citedSources = [sources[0]!];
  const topicSlug = makeTopicSlug('artificial-intelligence');
  const hubPath = 'reclaw/research/artificial-intelligence/_index.md';

  describe('FR-043: Q&A note structure', () => {
    it('returns a VaultNote with relativePath under reclaw/research/{slug}/QA/', () => {
      const note = buildQANote(question, resolvedAnswer, citedSources, topicSlug, hubPath);
      expect(note.relativePath).toMatch(/^reclaw\/research\/artificial-intelligence\/QA\//);
    });

    it('contains question as a heading', () => {
      const note = buildQANote(question, resolvedAnswer, citedSources, topicSlug, hubPath);
      expect(note.content).toContain(`# ${question}`);
    });

    it('contains the resolved answer with wikilinks', () => {
      const note = buildQANote(question, resolvedAnswer, citedSources, topicSlug, hubPath);
      expect(note.content).toContain('[[First Article#Passage 1]]');
    });

    it('contains sources section', () => {
      const note = buildQANote(question, resolvedAnswer, citedSources, topicSlug, hubPath);
      expect(note.content).toContain('## Sources');
    });

    it('lists cited source notes as wikilinks in sources section', () => {
      const note = buildQANote(question, resolvedAnswer, citedSources, topicSlug, hubPath);
      expect(note.content).toContain('[[First Article]]');
    });

    it('shows placeholder when no sources cited', () => {
      const note = buildQANote(question, resolvedAnswer, [], topicSlug, hubPath);
      expect(note.content).toContain('_No sources cited._');
    });

    it('contains disambiguated up link to hub note', () => {
      const note = buildQANote(question, resolvedAnswer, citedSources, topicSlug, hubPath);
      expect(note.content).toContain('[[artificial-intelligence/_index|artificial-intelligence]]');
    });

    it('contains question in frontmatter', () => {
      const note = buildQANote(question, resolvedAnswer, citedSources, topicSlug, hubPath);
      expect(note.content).toContain('question:');
    });

    it('contains topic tag in frontmatter', () => {
      const note = buildQANote(question, resolvedAnswer, citedSources, topicSlug, hubPath);
      expect(note.content).toContain('artificial-intelligence');
    });

    it('has YAML frontmatter delimiters', () => {
      const note = buildQANote(question, resolvedAnswer, citedSources, topicSlug, hubPath);
      expect(note.content).toMatch(/^---\n/);
      expect(note.content).toMatch(/\n---\n/);
    });
  });

  describe('multiple cited sources', () => {
    it('lists all cited source wikilinks', () => {
      const note = buildQANote(question, resolvedAnswer, sources, topicSlug, hubPath);
      expect(note.content).toContain('[[First Article]]');
      expect(note.content).toContain('[[YouTube Tutorial]]');
    });
  });

  describe('long question filename truncation', () => {
    it('truncates question to 50 chars in the filename', () => {
      const longQuestion = 'A'.repeat(60) + ' and more text';
      const note = buildQANote(longQuestion, resolvedAnswer, citedSources, topicSlug, hubPath);
      const parts = note.relativePath.split('/');
      const filename = parts[parts.length - 1]!;
      // Filename without .md extension should be <= 50 chars
      expect(filename.replace(/\.md$/, '').length).toBeLessThanOrEqual(50);
    });
  });
});

// ─── buildEmergencyNote ───────────────────────────────────────────────────────

describe('buildEmergencyNote', () => {
  it('returns a VaultNote with relativePath ending in _emergency.md', () => {
    const note = buildEmergencyNote(makeContext());
    expect(note.relativePath).toBe(
      'reclaw/research/artificial-intelligence/_emergency.md',
    );
  });

  it('marks the note as emergency in frontmatter', () => {
    const note = buildEmergencyNote(makeContext());
    expect(note.content).toContain('emergency: true');
  });

  it('contains the topic title', () => {
    const note = buildEmergencyNote(makeContext());
    expect(note.content).toContain('Artificial Intelligence');
  });

  it('contains the research date', () => {
    const note = buildEmergencyNote(makeContext());
    expect(note.content).toContain('2026-03-04');
  });

  it('contains all raw answers', () => {
    const note = buildEmergencyNote(makeContext());
    expect(note.content).toContain('What is AI?');
    expect(note.content).toContain('AI is the simulation of human intelligence');
    expect(note.content).toContain('How does ML work?');
    expect(note.content).toContain('ML uses statistical models');
  });

  it('lists all sources with URLs', () => {
    const note = buildEmergencyNote(makeContext());
    expect(note.content).toContain('https://example.com/first');
    expect(note.content).toContain('https://youtube.com/watch?v=abc');
  });

  it('contains emergency marker in title', () => {
    const note = buildEmergencyNote(makeContext());
    expect(note.content).toContain('[EMERGENCY]');
  });

  it('shows placeholder when no answers recorded', () => {
    const ctx = makeContext({ answers: {} });
    const note = buildEmergencyNote(ctx);
    expect(note.content).toContain('_No answers were recorded._');
  });

  it('shows placeholder when no sources', () => {
    const ctx = makeContext({ sources: [] });
    const note = buildEmergencyNote(ctx);
    expect(note.content).toContain('_No sources available._');
  });

  it('has YAML frontmatter delimiters', () => {
    const note = buildEmergencyNote(makeContext());
    expect(note.content).toMatch(/^---\n/);
    expect(note.content).toMatch(/\n---\n/);
  });
});

// ─── buildAllVaultNotes ───────────────────────────────────────────────────────

describe('buildAllVaultNotes', () => {
  it('returns an array of VaultNote objects', () => {
    const notes = buildAllVaultNotes(makeContext(), goodQuality);
    expect(Array.isArray(notes)).toBe(true);
    expect(notes.length).toBeGreaterThan(0);
  });

  it('FR-040: all note paths are under reclaw/research/{slug}/', () => {
    const notes = buildAllVaultNotes(makeContext(), goodQuality);
    for (const note of notes) {
      expect(note.relativePath).toMatch(/^reclaw\/research\/artificial-intelligence\//);
    }
  });

  it('FR-041: includes exactly one hub note (_index.md)', () => {
    const notes = buildAllVaultNotes(makeContext(), goodQuality);
    const hubNotes = notes.filter((n) => n.relativePath.endsWith('_index.md'));
    expect(hubNotes).toHaveLength(1);
  });

  it('FR-042: includes one source note per source', () => {
    const notes = buildAllVaultNotes(makeContext(), goodQuality);
    const sourceNotes = notes.filter((n) => n.relativePath.includes('/Sources/'));
    expect(sourceNotes).toHaveLength(sources.length);
  });

  it('FR-043: includes one Q&A note per answered question', () => {
    const notes = buildAllVaultNotes(makeContext(), goodQuality);
    const qaNotes = notes.filter((n) => n.relativePath.includes('/QA/'));
    expect(qaNotes).toHaveLength(Object.keys(makeContext().answers).length);
  });

  it('total note count = 1 hub + N sources + M answers', () => {
    const ctx = makeContext();
    const notes = buildAllVaultNotes(ctx, goodQuality);
    const expected = 1 + ctx.sources.length + Object.keys(ctx.answers).length;
    expect(notes).toHaveLength(expected);
  });

  it('all notes have non-empty content', () => {
    const notes = buildAllVaultNotes(makeContext(), goodQuality);
    for (const note of notes) {
      expect(note.content.trim().length).toBeGreaterThan(0);
    }
  });

  it('all notes have non-empty relativePaths', () => {
    const notes = buildAllVaultNotes(makeContext(), goodQuality);
    for (const note of notes) {
      expect(note.relativePath.trim().length).toBeGreaterThan(0);
    }
  });

  it('SC-007: Q&A notes have all [N] markers resolved (no bare [N] remains)', () => {
    const ctx = makeContext({
      answers: {
        'What is AI?': chatResponse('AI is intelligence [1] and [2].', [1, 2]),
      },
    });
    const notes = buildAllVaultNotes(ctx, goodQuality);
    const qaNotes = notes.filter((n) => n.relativePath.includes('/QA/'));
    for (const note of qaNotes) {
      // No bare [N] citation markers should remain
      expect(note.content).not.toMatch(/\[\d+\]/);
    }
  });

  it('Q&A notes contain wikilinks pointing to existing source notes', () => {
    const ctx = makeContext({
      answers: {
        'What is AI?': chatResponse('From [1] we know.', [1]),
      },
    });
    const notes = buildAllVaultNotes(ctx, goodQuality);
    const qaNotes = notes.filter((n) => n.relativePath.includes('/QA/'));
    const sourceNotes = notes.filter((n) => n.relativePath.includes('/Sources/'));

    // The QA note should contain a wikilink to a source that exists in sourceNotes
    for (const qaNote of qaNotes) {
      const wikilinkMatches = qaNote.content.match(/\[\[([^\]|]+)(?:#[^\]]+)?\]\]/g) ?? [];
      for (const wikilink of wikilinkMatches) {
        // Extract the note title from the wikilink (before #)
        const inner = wikilink.slice(2, wikilink.length - 2);
        const titlePart = inner.split('#')[0]!.trim();
        if (titlePart.endsWith('/_index')) continue; // hub note link
        // Check that a source note exists with this title in its path
        const matchingSource = sourceNotes.find((sn) =>
          sn.relativePath.includes(titlePart),
        );
        expect(matchingSource).toBeDefined();
      }
    }
  });

  it('source notes contain passage anchors for cited passages', () => {
    const ctx = makeContext({
      answers: {
        'What is AI?': chatResponse('From [1] we know.', [1]),
      },
    });
    const notes = buildAllVaultNotes(ctx, goodQuality);
    const firstSourceNote = notes.find((n) =>
      n.relativePath.includes('Sources/First Article.md'),
    );
    expect(firstSourceNote).toBeDefined();
    // Source at index 0 is cited by [1]
    expect(firstSourceNote!.content).toContain('## Passage 1');
  });

  it('produces no source notes when context has no sources', () => {
    const ctx = makeContext({ sources: [], answers: {} });
    const notes = buildAllVaultNotes(ctx, goodQuality);
    const sourceNotes = notes.filter((n) => n.relativePath.includes('/Sources/'));
    expect(sourceNotes).toHaveLength(0);
  });

  it('produces no Q&A notes when context has no answers', () => {
    const ctx = makeContext({ answers: {} });
    const notes = buildAllVaultNotes(ctx, goodQuality);
    const qaNotes = notes.filter((n) => n.relativePath.includes('/QA/'));
    expect(qaNotes).toHaveLength(0);
  });
});

// ─── VaultNote shape ─────────────────────────────────────────────────────────

describe('VaultNote shape', () => {
  it('hub note relativePath does not contain backslashes', () => {
    const note = buildHubNote(makeContext(), goodQuality);
    expect(note.relativePath).not.toContain('\\');
  });

  it('all notes from buildAllVaultNotes have .md extension', () => {
    const notes = buildAllVaultNotes(makeContext(), goodQuality);
    for (const note of notes) {
      expect(note.relativePath.endsWith('.md')).toBe(true);
    }
  });

  it('all paths are forward-slash separated', () => {
    const notes = buildAllVaultNotes(makeContext(), goodQuality);
    for (const note of notes) {
      expect(note.relativePath).not.toContain('\\');
    }
  });
});
