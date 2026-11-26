import { describe, expect, it } from 'vitest';
import { resolveStdinArgs } from './learn-args.js';

/** A stdin that records whether anyone read it. */
const stdin = (text: string) => {
  const reads: number[] = [];
  return {
    reads,
    read: async () => {
      reads.push(1);
      return text;
    },
  };
};

describe('resolveStdinArgs', () => {
  it.each([
    [
      ['signal', '-'],
      ['signal', '[{"a":1}]'],
    ],
    [
      ['propose', '-'],
      ['propose', '[{"a":1}]'],
    ],
    [
      ['grade', 'r-1', 'c/c01', 'good', '--answer', '-'],
      ['grade', 'r-1', 'c/c01', 'good', '--answer', '[{"a":1}]'],
    ],
  ])('replaces the placeholder of %j with the trimmed stdin text', async (args, expected) => {
    const input = stdin('  [{"a":1}]\n');
    expect(await resolveStdinArgs(args, input.read)).toEqual(expected);
    expect(input.reads).toHaveLength(1);
  });

  it('keeps `$`, backticks and quotes literal: the text is passed as one argument, never parsed', async () => {
    const text = 'costs $HOME and `rm -rf` and "quotes"';
    expect(await resolveStdinArgs(['signal', '-'], stdin(text).read)).toEqual(['signal', text]);
  });

  it.each([
    [['signal', '[]']], // a batch passed inline
    [['propose', '[]']],
    [['grade', 'r-1', 'c/c01', 'good', '--answer', 'typed']],
    [['grade', 'r-1', 'c/c01', 'good']],
    [['status']],
    [['lesson', '--message']],
    [['suspend', 'c/c01', '-']], // a lone dash is only a placeholder where a command says so
    [['signals', '-']],
    [['proposal-dismiss', 'slug', '-']],
    [[]],
  ])('never reads stdin for %j', async (args) => {
    const input = stdin('should not be read');
    expect(await resolveStdinArgs(args, input.read)).toEqual(args);
    expect(input.reads).toHaveLength(0);
  });

  it('does not mutate the arguments it was given', async () => {
    const args = ['signal', '-'] as const;
    await resolveStdinArgs(args, stdin('x').read);
    expect(args).toEqual(['signal', '-']);
  });
});
