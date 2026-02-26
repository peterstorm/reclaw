import { describe, expect, it } from 'vitest';
import { buildChatPrompt, buildPrompt } from './prompt-builder.js';
import type { PromptContext } from './prompt-builder.js';

// ─── buildPrompt ─────────────────────────────────────────────────────────────

describe('buildPrompt', () => {
  const baseContext: PromptContext = {
    date: '2026-02-26',
    dayOfWeek: 'Thursday',
    personality: 'You are a helpful agent.',
    userMessage: 'What is the news today?',
  };

  it('interpolates {{date}}', () => {
    const result = buildPrompt('Today is {{date}}.', baseContext);
    expect(result).toBe('Today is 2026-02-26.');
  });

  it('interpolates {{dayOfWeek}}', () => {
    const result = buildPrompt('It is {{dayOfWeek}}.', baseContext);
    expect(result).toBe('It is Thursday.');
  });

  it('interpolates {{personality}}', () => {
    const result = buildPrompt('{{personality}}', baseContext);
    expect(result).toBe('You are a helpful agent.');
  });

  it('interpolates {{userMessage}}', () => {
    const result = buildPrompt('User asked: {{userMessage}}', baseContext);
    expect(result).toBe('User asked: What is the news today?');
  });

  it('interpolates all variables in one template', () => {
    const template = '{{personality}}\nDate: {{date}} ({{dayOfWeek}})\nUser: {{userMessage}}';
    const result = buildPrompt(template, baseContext);
    expect(result).toBe(
      'You are a helpful agent.\nDate: 2026-02-26 (Thursday)\nUser: What is the news today?',
    );
  });

  it('leaves unknown variables unchanged', () => {
    const result = buildPrompt('Hello {{unknown}}!', baseContext);
    expect(result).toBe('Hello {{unknown}}!');
  });

  it('does not interpolate userMessage when not in context', () => {
    const ctx: PromptContext = {
      date: '2026-02-26',
      dayOfWeek: 'Thursday',
      personality: 'Agent.',
    };
    const result = buildPrompt('Message: {{userMessage}}', ctx);
    // userMessage undefined — variable left as-is
    expect(result).toBe('Message: {{userMessage}}');
  });

  it('handles template with no variables', () => {
    const result = buildPrompt('No variables here.', baseContext);
    expect(result).toBe('No variables here.');
  });

  it('handles empty template', () => {
    const result = buildPrompt('', baseContext);
    expect(result).toBe('');
  });

  it('handles multiple occurrences of same variable', () => {
    const result = buildPrompt('{{date}} and {{date}}', baseContext);
    expect(result).toBe('2026-02-26 and 2026-02-26');
  });
});

// ─── buildChatPrompt ──────────────────────────────────────────────────────────

describe('buildChatPrompt', () => {
  it('combines personality and userMessage with separator', () => {
    const result = buildChatPrompt('You are a helpful agent.', 'What time is it?');
    expect(result).toBe('You are a helpful agent.\n\n---\n\nWhat time is it?');
  });

  it('returns just the message when personality is empty', () => {
    const result = buildChatPrompt('', 'Hello!');
    expect(result).toBe('Hello!');
  });

  it('returns just the message when personality is whitespace', () => {
    const result = buildChatPrompt('   ', 'Hello!');
    expect(result).toBe('Hello!');
  });

  it('trims personality and message', () => {
    const result = buildChatPrompt('  Agent.  ', '  Ask something.  ');
    expect(result).toBe('Agent.\n\n---\n\nAsk something.');
  });

  it('handles multi-line personality', () => {
    const personality = 'You are a helpful agent.\nBe concise.\nBe accurate.';
    const message = 'What is the weather?';
    const result = buildChatPrompt(personality, message);
    expect(result).toBe(`${personality}\n\n---\n\n${message}`);
  });

  it('handles empty message with personality', () => {
    const result = buildChatPrompt('You are an agent.', '');
    expect(result).toBe('You are an agent.\n\n---\n\n');
  });
});
