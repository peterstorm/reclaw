import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { errorMessage } from './error-message.js';

describe('errorMessage', () => {
  it('reads the message of an Error, subclasses included', () => {
    expect(errorMessage(new Error('disk full'))).toBe('disk full');
    expect(errorMessage(new TypeError('not a function'))).toBe('not a function');
  });

  it('stringifies anything else that was thrown', () => {
    expect(errorMessage('plain string')).toBe('plain string');
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(undefined)).toBe('undefined');
    expect(errorMessage(null)).toBe('null');
    expect(errorMessage({ code: 'ENOENT' })).toBe('[object Object]');
  });

  it('returns the Error message verbatim for any message', () => {
    fc.assert(
      fc.property(fc.string(), (message) => {
        expect(errorMessage(new Error(message))).toBe(message);
      }),
    );
  });
});
