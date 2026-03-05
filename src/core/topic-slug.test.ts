import { describe, expect, it } from 'vitest';
import { generateTopicSlug } from './topic-slug.js';

// ─── generateTopicSlug ────────────────────────────────────────────────────────

describe('generateTopicSlug', () => {
  // Basic transformations

  it('lowercases the topic', () => {
    const slug = generateTopicSlug('Machine Learning');
    expect(slug).toBe('machine-learning');
  });

  it('replaces spaces with hyphens', () => {
    const slug = generateTopicSlug('deep neural networks');
    expect(slug).toBe('deep-neural-networks');
  });

  it('replaces multiple spaces with a single hyphen', () => {
    const slug = generateTopicSlug('deep  neural   networks');
    expect(slug).toBe('deep-neural-networks');
  });

  it('strips non-alphanumeric characters', () => {
    const slug = generateTopicSlug('C++ programming & design!');
    expect(slug).toBe('c-programming-design');
  });

  it('preserves existing hyphens', () => {
    const slug = generateTopicSlug('self-driving cars');
    expect(slug).toBe('self-driving-cars');
  });

  it('collapses consecutive hyphens', () => {
    const slug = generateTopicSlug('AI -- future prospects');
    expect(slug).toBe('ai-future-prospects');
  });

  it('strips leading hyphens', () => {
    const slug = generateTopicSlug('  leading spaces');
    expect(slug).toBe('leading-spaces');
  });

  it('strips trailing hyphens', () => {
    const slug = generateTopicSlug('trailing spaces  ');
    expect(slug).toBe('trailing-spaces');
  });

  // Length limit

  it('truncates to 60 characters', () => {
    const topic = 'a'.repeat(100);
    const slug = generateTopicSlug(topic);
    expect(slug.length).toBeLessThanOrEqual(60);
  });

  it('does not add trailing hyphen after truncation', () => {
    // 58 'a's + space + 'b' = 60 chars before truncation produces a hyphen at position 59
    const topic = 'a'.repeat(58) + ' b';
    const slug = generateTopicSlug(topic);
    expect(slug.endsWith('-')).toBe(false);
    expect(slug.length).toBeLessThanOrEqual(60);
  });

  it('produces exactly 60 chars when topic is long with only word chars', () => {
    const topic = 'a'.repeat(80);
    const slug = generateTopicSlug(topic);
    expect(slug).toBe('a'.repeat(60));
  });

  // Edge cases

  it('handles empty string by returning "untitled"', () => {
    const slug = generateTopicSlug('');
    expect(slug).toBe('untitled');
  });

  it('handles whitespace-only string by returning "untitled"', () => {
    const slug = generateTopicSlug('   ');
    expect(slug).toBe('untitled');
  });

  it('handles string with only special characters by returning "untitled"', () => {
    const slug = generateTopicSlug('!@#$%^&*()');
    expect(slug).toBe('untitled');
  });

  it('handles single word', () => {
    const slug = generateTopicSlug('Quantum');
    expect(slug).toBe('quantum');
  });

  it('handles numbers in topic', () => {
    const slug = generateTopicSlug('GPT-4 capabilities 2024');
    expect(slug).toBe('gpt-4-capabilities-2024');
  });

  it('handles unicode letters by stripping them', () => {
    // Non-ASCII unicode chars are stripped since they are not [a-z0-9]
    const slug = generateTopicSlug('café culture');
    // 'é' is stripped, leaving 'caf' + '-culture'
    expect(slug).toBe('caf-culture');
  });

  it('handles topic that is just hyphens by returning "untitled"', () => {
    const slug = generateTopicSlug('---');
    expect(slug).toBe('untitled');
  });

  // Branding

  it('returns a TopicSlug branded type', () => {
    const slug = generateTopicSlug('test topic');
    // Structural check -- the value is a string
    expect(typeof slug).toBe('string');
  });

  // URL-safety

  it('produces URL-safe output (no spaces, no special chars)', () => {
    const slug = generateTopicSlug('The impact of AI on healthcare & medicine (2024)');
    expect(slug).toMatch(/^[a-z0-9-]+$/);
  });

  it('does not start with a hyphen', () => {
    const slug = generateTopicSlug('  leading spaces');
    expect(slug.startsWith('-')).toBe(false);
  });

  it('does not end with a hyphen', () => {
    const slug = generateTopicSlug('trailing spaces  ');
    expect(slug.endsWith('-')).toBe(false);
  });

  // Real-world topics

  it('slugifies a realistic research topic', () => {
    const slug = generateTopicSlug('Large Language Models: Advances and Limitations (2024)');
    expect(slug).toBe('large-language-models-advances-and-limitations-2024');
  });

  it('slugifies a topic with parentheses', () => {
    const slug = generateTopicSlug('climate change (IPCC report)');
    expect(slug).toBe('climate-change-ipcc-report');
  });
});
