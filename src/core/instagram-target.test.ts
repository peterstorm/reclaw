import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type InstagramTarget,
  InstagramUsername,
  parseInstagramTarget,
} from './instagram-target.js';

const ok = (raw: string): InstagramTarget => {
  const r = parseInstagramTarget(raw);
  if (!r.ok) throw new Error(`expected ok for ${raw}: ${r.error}`);
  return r.value;
};

describe('parseInstagramTarget — posts', () => {
  it.each([
    ['https://www.instagram.com/reel/Db4K_XVyZOB/', 'reel'],
    ['https://www.instagram.com/reel/Db4K_XVyZOB/?igsh=abc123&utm_source=qr', 'reel'],
    ['https://instagram.com/reels/Db4K_XVyZOB', 'reel'],
    ['https://www.instagram.com/tv/Db4K_XVyZOB/', 'reel'],
    ['https://www.instagram.com/p/Db4K_XVyZOB/', 'post'],
    ['https://www.instagram.com/bashi_fuirkashi/reel/Db4K_XVyZOB/', 'reel'],
    ['https://www.instagram.com/bashi_fuirkashi/p/Db4K_XVyZOB/', 'post'],
    ['instagram.com/p/Db4K_XVyZOB', 'post'],
  ])('%s → %s', (raw, format) => {
    expect(ok(raw)).toEqual({
      kind: 'post',
      format,
      shortCode: 'Db4K_XVyZOB',
      url: `https://www.instagram.com/${format === 'reel' ? 'reel' : 'p'}/Db4K_XVyZOB/`,
    });
  });
});

describe('parseInstagramTarget — profiles', () => {
  it.each([
    'https://www.instagram.com/Bashi_Fuirkashi/',
    'https://www.instagram.com/bashi_fuirkashi/?hl=en',
    '@bashi_fuirkashi',
    'instagram.com/bashi_fuirkashi',
  ])('%s', (raw) => {
    expect(ok(raw)).toEqual({
      kind: 'profile',
      username: 'bashi_fuirkashi',
      url: 'https://www.instagram.com/bashi_fuirkashi/',
    });
  });
});

describe('parseInstagramTarget — rejections', () => {
  it.each([
    ['', /required/i],
    ['https://example.com/reel/Db4K_XVyZOB/', /not an instagram/i],
    ['https://www.instagram.com/', /no profile or media/i],
    ['https://www.instagram.com/reel/', /missing shortcode/i],
    ['https://www.instagram.com/reel/a/', /invalid instagram shortcode/i],
    ['https://www.instagram.com/stories/someone/123/', /stories/i],
    ['https://www.instagram.com/explore/', /section/i],
    ['@bad name', /invalid instagram username/i],
    ['not a url at all', /./],
    ['https://www.instagram.com/accounts/login/', /section/i],
  ])('%j', (raw, message) => {
    const r = parseInstagramTarget(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(message);
  });
});

describe('parseInstagramTarget — properties', () => {
  const shortCode = fc.stringMatching(/^[A-Za-z0-9_-]{5,40}$/);
  const handle = fc
    .stringMatching(/^[a-z0-9_][a-z0-9_.]{0,28}[a-z0-9_]$/)
    .filter((h) => !h.includes('..'))
    .filter(
      (h) =>
        ![
          'p',
          'reel',
          'reels',
          'tv',
          'stories',
          'explore',
          'accounts',
          'direct',
          'about',
          'developer',
          'legal',
          'web',
          'directory',
          'challenge',
          'oauth',
          'api',
        ].includes(h),
    );

  it('never throws on arbitrary input', () => {
    fc.assert(fc.property(fc.string(), (raw) => void parseInstagramTarget(raw)));
  });

  it('canonical URLs re-parse to the same target (idempotent)', () => {
    fc.assert(
      fc.property(shortCode, fc.constantFrom('p', 'reel', 'reels', 'tv'), (code, segment) => {
        const once = ok(`https://www.instagram.com/${segment}/${code}/?igsh=x`);
        expect(ok(once.url)).toEqual(once);
      }),
    );
  });

  it('profile URLs round-trip and are lower-cased', () => {
    fc.assert(
      fc.property(handle, (h) => {
        const target = ok(`@${h.toUpperCase()}`);
        expect(target.kind).toBe('profile');
        expect(ok(target.url)).toEqual(target);
      }),
    );
  });
});

describe('InstagramUsername — path safety', () => {
  it.each(['.', '..', '.hidden', 'trailing.', 'a..b'])('rejects %j', (raw) => {
    expect(InstagramUsername(raw).ok).toBe(false);
  });
});
