import { describe, expect, it } from 'vitest';
import { parseAskCommand } from './ask-request.js';

describe('parseAskCommand', () => {
  it('parses slug and question', () => {
    const r = parseAskCommand('/ask my-topic What is the main claim?');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.slug).toBe('my-topic');
      expect(r.value.question).toBe('What is the main claim?');
    }
  });

  it('keeps the full question with multiple words', () => {
    const r = parseAskCommand('/ask agents Compare option A and option B in detail');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.slug).toBe('agents');
      expect(r.value.question).toBe('Compare option A and option B in detail');
    }
  });

  it('parses a canonical vault path down to its topic slug', () => {
    const r = parseAskCommand('/ask reclaw/research/my-topic Why?');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.slug).toBe('my-topic');
      expect(r.value.question).toBe('Why?');
    }
  });

  it.each([
    '/ask ../outside Why?',
    '/ask reclaw/research/../../outside Why?',
    '/ask nested/arbitrary/topic Why?',
    '/ask /absolute Why?',
  ])('rejects unsafe topic reference: %s', (command) => {
    const result = parseAskCommand(command);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/invalid topic slug/i);
  });

  it('keeps newlines inside the question body', () => {
    const r = parseAskCommand('/ask t1 first line\nsecond line');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.question).toBe('first line\nsecond line');
    }
  });

  it('is case-insensitive on the prefix', () => {
    const r = parseAskCommand('/ASK topic Question?');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.slug).toBe('topic');
      expect(r.value.question).toBe('Question?');
    }
  });

  it('rejects empty body', () => {
    const r = parseAskCommand('/ask');
    expect(r.ok).toBe(false);
  });

  it('rejects slug without question', () => {
    const r = parseAskCommand('/ask my-topic');
    expect(r.ok).toBe(false);
  });

  it('rejects slug with only whitespace after', () => {
    const r = parseAskCommand('/ask my-topic    ');
    expect(r.ok).toBe(false);
  });

  it('rejects non-/ask messages', () => {
    const r = parseAskCommand('hello world');
    expect(r.ok).toBe(false);
  });
});
