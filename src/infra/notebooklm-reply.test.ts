import { describe, expect, it } from 'vitest';
import { addedTextSourceId, stringField } from './notebooklm-reply.js';

describe('stringField', () => {
  it('reads a non-empty string field', () => {
    expect(stringField({ audioId: 'audio-1' }, 'audioId')).toBe('audio-1');
  });

  it.each([
    ['a missing field', {}],
    ['an empty string', { audioId: '' }],
    ['a number', { audioId: 42 }],
    ['null', { audioId: null }],
    ['an array', { audioId: ['audio-1'] }],
    ['a nested object', { audioId: { id: 'audio-1' } }],
  ])('returns null for %s', (_label, reply) => {
    expect(stringField(reply, 'audioId')).toBeNull();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a bare string', 'audio-1'],
    ['an array', [{ audioId: 'audio-1' }]],
    ['a number', 7],
  ])('returns null when the reply is %s', (_label, reply) => {
    expect(stringField(reply, 'audioId')).toBeNull();
  });
});

describe('addedTextSourceId', () => {
  it('takes a plain string reply as the source id', () => {
    expect(addedTextSourceId('src-1')).toBe('src-1');
  });

  it('returns null for an empty string reply', () => {
    expect(addedTextSourceId('')).toBeNull();
  });

  it('prefers sourceId, then allSourceIds, then sourceIds', () => {
    expect(
      addedTextSourceId({ sourceId: 'a', allSourceIds: ['b'], sourceIds: ['c'], wasChunked: true }),
    ).toBe('a');
    expect(addedTextSourceId({ allSourceIds: ['b', 'x'], sourceIds: ['c'] })).toBe('b');
    expect(addedTextSourceId({ sourceIds: ['c', 'y'] })).toBe('c');
  });

  it('skips an absent or null field but not an empty one, as the SDK lookup always did', () => {
    expect(addedTextSourceId({ sourceId: null, allSourceIds: ['b'] })).toBe('b');
    expect(addedTextSourceId({ allSourceIds: [], sourceIds: ['c'] })).toBe('c');
    expect(addedTextSourceId({ sourceId: '', allSourceIds: ['b'] })).toBeNull();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 7],
    ['an array', ['src-1']],
    ['a chunked reply with no ids', { wasChunked: true }],
    ['a numeric sourceId', { sourceId: 7 }],
    ['an id list that is a string', { allSourceIds: 'src-1' }],
    ['an id list of numbers', { sourceIds: [7] }],
    ['an id list with an empty id', { sourceIds: [''] }],
  ])('returns null for %s', (_label, reply) => {
    expect(addedTextSourceId(reply)).toBeNull();
  });
});
