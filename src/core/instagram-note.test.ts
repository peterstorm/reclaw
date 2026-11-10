import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { photoPost, sampleTranscript, videoPost } from './__fixtures__/instagram.js';
import {
  addChangelogEntry,
  addMocEntries,
  ingestChangelogBullet,
  instagramNotePath,
  instagramNoteTitle,
  mocEntryOf,
  renderInstagramNote,
} from './instagram-note.js';

describe('instagramNotePath', () => {
  it('files notes under media/instagram/<owner>/<shortcode>.md', () => {
    expect(instagramNotePath(videoPost())).toBe('media/instagram/bashi_fuirkashi/Db4K_XVyZOB.md');
  });
});

describe('instagramNoteTitle', () => {
  it('uses the first non-empty caption line', () => {
    expect(instagramNoteTitle(videoPost({ caption: '\n  \nHello there\nsecond' }))).toBe(
      'Hello there',
    );
  });

  it('truncates long first lines with an ellipsis', () => {
    const title = instagramNoteTitle(videoPost({ caption: 'x'.repeat(200) }));
    expect(title).toHaveLength(80);
    expect(title.endsWith('…')).toBe(true);
  });

  it('falls back to handle + shortcode for empty captions', () => {
    expect(instagramNoteTitle(videoPost({ caption: '  ' }))).toBe('@bashi_fuirkashi — Db4K_XVyZOB');
  });
});

describe('renderInstagramNote', () => {
  const rendered = renderInstagramNote({
    post: videoPost(),
    body: {
      kind: 'transcribed',
      transcript: sampleTranscript,
      videoPath: '/home/u/downloads/instagram/x.mp4',
    },
    ingestedOn: '2026-11-09',
  });

  it('carries the vault frontmatter standard', () => {
    expect(rendered).toMatch(/^---\ntitle: "I have been coding for 6 years\."\ndate: 2026-08-10\n/);
    expect(rendered).toContain('tags: [instagram, video]');
    expect(rendered).toContain('aliases: []');
    expect(rendered).toContain('up: "[[media/instagram/MOC|Instagram]]"');
  });

  it('records provenance, language, duration and the kept video', () => {
    expect(rendered).toContain('source: "https://www.instagram.com/p/Db4K_XVyZOB/"');
    expect(rendered).toContain('author: bashi_fuirkashi');
    expect(rendered).toContain('ingested: 2026-11-09');
    expect(rendered).toContain('language: en');
    expect(rendered).toContain('duration: 33');
    expect(rendered).toContain('video: "/home/u/downloads/instagram/x.mp4"');
  });

  it('includes caption and timestamped transcript', () => {
    expect(rendered).toContain('## Caption\n\nI have been coding for 6 years.');
    expect(rendered).toContain('## Transcript\n\n[0:00] I have been coding for six years.');
    expect(rendered).toContain('[1:02:05] Much later.');
  });

  it('omits the video field when no video was kept', () => {
    const note = renderInstagramNote({
      post: videoPost(),
      body: { kind: 'transcribed', transcript: sampleTranscript, videoPath: null },
      ingestedOn: '2026-11-09',
    });
    expect(note).not.toContain('video:');
  });

  it('says so when there is no speech', () => {
    const note = renderInstagramNote({
      post: videoPost(),
      body: { kind: 'transcribed', transcript: { language: 'en', segments: [] }, videoPath: null },
      ingestedOn: '2026-11-09',
    });
    expect(note).toContain('_No speech detected._');
  });

  it('renders a caption-only note for posts without video', () => {
    const note = renderInstagramNote({
      post: photoPost(),
      body: { kind: 'no-video' },
      ingestedOn: '2026-11-09',
    });
    expect(note).toContain('tags: [instagram, image]');
    expect(note).toContain('_No video in this post._');
    expect(note).not.toContain('## Transcript');
    expect(note).not.toContain('language:');
  });

  it('escapes YAML-hostile titles', () => {
    const note = renderInstagramNote({
      post: videoPost({ caption: 'Tip: "quotes" & colons: here' }),
      body: { kind: 'no-video' },
      ingestedOn: '2026-11-09',
    });
    expect(note).toContain('title: "Tip: \\"quotes\\" & colons: here"');
  });

  it('is deterministic (property)', () => {
    fc.assert(
      fc.property(fc.string(), (caption) => {
        const input = {
          post: videoPost({ caption }),
          body: { kind: 'no-video' } as const,
          ingestedOn: '2026-11-09',
        };
        expect(renderInstagramNote(input)).toBe(renderInstagramNote(input));
      }),
    );
  });
});

describe('addMocEntries', () => {
  const entry = mocEntryOf(videoPost());

  it('creates the MOC with vault frontmatter when absent', () => {
    const moc = addMocEntries(null, [entry], '2026-11-09');
    expect(moc).toMatch(/^---\ntitle: Instagram\ndate: 2026-11-09\ntags: \[moc, instagram\]/);
    expect(moc).toContain('up: "[[_index]]"');
    expect(moc).toContain(
      '- [[media/instagram/bashi_fuirkashi/Db4K_XVyZOB|I have been coding for 6 years.]] — @bashi_fuirkashi, 2026-08-10',
    );
  });

  it('is idempotent (property): adding the same entries twice changes nothing', () => {
    fc.assert(
      fc.property(fc.string(), (caption) => {
        const e = mocEntryOf(videoPost({ caption }));
        const once = addMocEntries(null, [e], '2026-11-09');
        expect(addMocEntries(once, [e], '2026-11-10')).toBe(once);
      }),
    );
  });

  it('sanitises titles that would break a wikilink', () => {
    const moc = addMocEntries(
      null,
      [mocEntryOf(videoPost({ caption: 'a | b [c]' }))],
      '2026-11-09',
    );
    expect(moc).toContain('|a / b c]]');
  });
});

describe('addChangelogEntry', () => {
  const base =
    '---\ntitle: Changelog\n---\n# Changelog\n\n## 2026-11-09\n\n- **added** [[older]]\n\n## 2026-11-08\n\n- x\n';

  it('adds under an existing date heading, newest first', () => {
    const out = addChangelogEntry(base, '2026-11-09', '- **added** [[new]]');
    expect(out).toContain('## 2026-11-09\n\n- **added** [[new]]\n- **added** [[older]]');
  });

  it('creates the date heading below the title when missing', () => {
    const out = addChangelogEntry(base, '2026-11-10', '- **added** [[new]]');
    expect(out).toContain('# Changelog\n\n## 2026-11-10\n\n- **added** [[new]]\n\n## 2026-11-09');
  });
});

describe('ingestChangelogBullet', () => {
  it('is null for no posts', () => {
    expect(ingestChangelogBullet([])).toBeNull();
  });

  it('links a single note', () => {
    expect(ingestChangelogBullet([videoPost()])).toBe(
      '- **added** [[media/instagram/bashi_fuirkashi/Db4K_XVyZOB]] to `media/instagram/bashi_fuirkashi/` — Instagram video by @bashi_fuirkashi, caption + Whisper transcript',
    );
  });

  it('summarises a batch by owner', () => {
    expect(ingestChangelogBullet([videoPost(), photoPost()])).toBe(
      '- **added** 2 Instagram posts by @bashi_fuirkashi to [[media/instagram/MOC]] — captions + Whisper transcripts',
    );
  });
});
