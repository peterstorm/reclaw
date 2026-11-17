import type { InstagramPost } from '../instagram-post.js';
import type { ImageReading, OcrLine } from '../instagram-screen-text.js';
import { InstagramUsername, ShortCode } from '../instagram-target.js';
import type { Transcript } from '../instagram-transcript.js';

/** Shape of one `apify/instagram-scraper` dataset row for a video post (trimmed). */
export const rawVideoItem = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: '3960964207126090625',
  type: 'Video',
  productType: 'clips',
  shortCode: 'Db4K_XVyZOB',
  url: 'https://www.instagram.com/p/Db4K_XVyZOB/',
  ownerUsername: 'bashi_fuirkashi',
  caption: 'I have been coding for 6 years.\nSeven habits for AI engineers:\n1. Read real books',
  hashtags: [],
  likesCount: 112,
  commentsCount: 78,
  timestamp: '2026-08-10T23:15:04.000Z',
  videoUrl: 'https://scontent-ams2-1.cdninstagram.com/o1/v/video.mp4?oe=6A1D0A5C',
  audioUrl: 'https://scontent-ams2-1.cdninstagram.com/o1/v/audio.mp4?oe=6A1D0A5C',
  videoDuration: 33.4,
  ...overrides,
});

/** A carousel row: no `videoUrl`; `images` lists each image (the last one may repeat). */
export const rawSidecarItem = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
  rawVideoItem({
    type: 'Sidecar',
    productType: null,
    shortCode: 'DWg4jmJFQSp',
    url: 'https://www.instagram.com/p/DWg4jmJFQSp/',
    videoUrl: null,
    audioUrl: null,
    videoDuration: null,
    alt: 'Photo by Bashiri Smith on March 30, 2026.',
    displayUrl: 'https://cdn.example/1.jpg',
    images: ['https://cdn.example/1.jpg', 'https://cdn.example/2.jpg', 'https://cdn.example/2.jpg'],
    ...overrides,
  });

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

export const videoPost = (overrides: Partial<InstagramPost> = {}): InstagramPost => ({
  shortCode: unwrap(ShortCode('Db4K_XVyZOB')),
  url: 'https://www.instagram.com/p/Db4K_XVyZOB/',
  owner: unwrap(InstagramUsername('bashi_fuirkashi')),
  caption: 'I have been coding for 6 years.\nSeven habits for AI engineers',
  altText: null,
  postedAt: '2026-08-10T23:15:04.000Z',
  hashtags: [],
  likes: 112,
  comments: 78,
  media: {
    kind: 'video',
    videoUrl: 'https://cdn.example/video.mp4',
    audioUrl: 'https://cdn.example/audio.mp4',
    durationSeconds: 33.4,
  },
  ...overrides,
});

export const photoPost = (overrides: Partial<InstagramPost> = {}): InstagramPost =>
  videoPost({
    shortCode: unwrap(ShortCode('DWg4jmJFQSp')),
    url: 'https://www.instagram.com/p/DWg4jmJFQSp/',
    media: { kind: 'images', imageUrls: ['https://cdn.example/1.jpg'] },
    ...overrides,
  });

/** One OCR line at a given vertical position (same `top` = same place on screen). */
export const ocrLine = (text: string, top = 100, confidence = 90): OcrLine => ({
  text,
  confidence,
  box: { left: 50, top, width: 400, height: 40 },
});

/** A reading where every variant saw the same lines. */
export const reading = (...lines: OcrLine[]): ImageReading => ({ variants: [lines, lines] });

export const sampleTranscript: Transcript = {
  language: 'en',
  segments: [
    { startSeconds: 0, text: 'I have been coding for six years.' },
    { startSeconds: 4.2, text: 'Here are seven habits.' },
    { startSeconds: 3725, text: 'Much later.' },
  ],
};
