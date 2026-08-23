import { describe, expect, it } from 'vitest';
import { piBackend } from './pi-backend.js';

describe('piBackend', () => {
  describe('name', () => {
    it('is "pi"', () => {
      expect(piBackend.name).toBe('pi');
    });
  });

  describe('buildArgs', () => {
    it('builds args without session', () => {
      const result = piBackend.buildArgs({
        allowedTools: ['Read', 'Write', 'Bash'],
      });
      expect(result).toEqual(['pi', '-p', '--mode', 'json', '--tools', 'read,write,bash']);
    });

    it('builds args with session (--session BEFORE -p)', () => {
      const result = piBackend.buildArgs({
        resumeSessionId: 'abc-123',
        allowedTools: ['Read', 'Write', 'Bash'],
      });
      expect(result).toEqual([
        'pi',
        '--session',
        'abc-123',
        '-p',
        '--mode',
        'json',
        '--tools',
        'read,write,bash',
      ]);
    });

    it('lowercases tool names', () => {
      const result = piBackend.buildArgs({
        allowedTools: ['Read', 'Write', 'Bash'],
      });
      expect(result).toContain('read,write,bash');
    });

    it('handles custom tools like recall, remember', () => {
      const result = piBackend.buildArgs({
        allowedTools: ['Read', 'Write', 'Bash', 'Recall', 'Remember'],
      });
      expect(result).toEqual([
        'pi',
        '-p',
        '--mode',
        'json',
        '--tools',
        'read,write,bash,recall,remember',
      ]);
    });

    it('enables Pi delegation while harmlessly carrying alternate-backend names', () => {
      const result = piBackend.buildArgs({
        allowedTools: ['Edit', 'Task', 'Skill', 'subagent'],
      });
      expect(result).toEqual(['pi', '-p', '--mode', 'json', '--tools', 'edit,task,skill,subagent']);
    });

    it('uses --no-tools when allowedTools is empty', () => {
      const result = piBackend.buildArgs({ allowedTools: [] });
      expect(result).toEqual(['pi', '-p', '--mode', 'json', '--no-tools']);
      expect(result).not.toContain('--tools');
    });

    it('adds provider and model flags when modelSelection is configured', () => {
      const result = piBackend.buildArgs({
        allowedTools: [],
        modelSelection: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      });
      expect(result).toEqual([
        'pi',
        '--provider',
        'deepseek',
        '--model',
        'deepseek-v4-flash',
        '-p',
        '--mode',
        'json',
        '--no-tools',
      ]);
    });

    it('keeps --session before -p when modelSelection is configured', () => {
      const result = piBackend.buildArgs({
        resumeSessionId: 'abc-123',
        allowedTools: ['Read'],
        modelSelection: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      });
      expect(result.slice(0, 6)).toEqual([
        'pi',
        '--session',
        'abc-123',
        '--provider',
        'deepseek',
        '--model',
      ]);
      expect(result.indexOf('--session')).toBeLessThan(result.indexOf('-p'));
    });
  });

  describe('cleanEnv', () => {
    it('passes env through unchanged', () => {
      const env = {
        HOME: '/home/user',
        PATH: '/usr/bin',
        CUSTOM_VAR: 'value',
        UNDEFINED_VAR: undefined,
      };
      const result = piBackend.cleanEnv(env);
      expect(result).toBe(env); // same reference — no mutation
    });
  });

  describe('parseResult', () => {
    it('extracts text from message_end content array', () => {
      const rawOutput = JSON.stringify({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello, world!' }],
        },
      });
      const result = piBackend.parseResult(rawOutput);
      expect(result.text).toBe('Hello, world!');
    });

    it('extracts sessionId from session line', () => {
      const rawOutput = JSON.stringify({
        type: 'session',
        id: 'session-uuid-123',
      });
      const result = piBackend.parseResult(rawOutput);
      expect(result.sessionId).toBe('session-uuid-123');
    });

    it('handles multi-line output with both session and message_end', () => {
      const lines = [
        JSON.stringify({ type: 'session', id: 'sess-42' }),
        JSON.stringify({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'Hi' },
        }),
        JSON.stringify({
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Hello from Pi!' }] },
        }),
      ];
      const rawOutput = lines.join('\n');
      const result = piBackend.parseResult(rawOutput);
      expect(result.sessionId).toBe('sess-42');
      expect(result.text).toBe('Hello from Pi!');
    });

    it('returns only the LAST message_end text (discards intermediate narration)', () => {
      const lines = [
        JSON.stringify({ type: 'session', id: 'sess-99' }),
        // First assistant message — intermediate narration before tool call
        JSON.stringify({
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Let me check the calendar...' }],
          },
        }),
        // Second assistant message — more narration before another tool call
        JSON.stringify({
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Now let me gather git activity...' }],
          },
        }),
        // Final assistant message — the actual user-facing response
        JSON.stringify({
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Here is your weekly summary!' }],
          },
        }),
      ];
      const rawOutput = lines.join('\n');
      const result = piBackend.parseResult(rawOutput);
      expect(result.text).toBe('Here is your weekly summary!');
      expect(result.sessionId).toBe('sess-99');
    });

    it('returns nulls when no relevant events found', () => {
      const rawOutput = [
        JSON.stringify({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'Hi' },
        }),
        'some random line',
        '',
      ].join('\n');
      const result = piBackend.parseResult(rawOutput);
      expect(result.text).toBeNull();
      expect(result.sessionId).toBeNull();
    });

    it('handles message_end with multiple content blocks (joins text)', () => {
      const rawOutput = JSON.stringify({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'First paragraph.' },
            { type: 'thinking', text: 'internal thought' },
            { type: 'text', text: 'Second paragraph.' },
          ],
        },
      });
      const result = piBackend.parseResult(rawOutput);
      expect(result.text).toBe('First paragraph.\nSecond paragraph.');
    });

    it('returns null text when message_end has no text blocks', () => {
      const rawOutput = JSON.stringify({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', text: 'just thinking' }],
        },
      });
      const result = piBackend.parseResult(rawOutput);
      expect(result.text).toBeNull();
    });

    it('skips intermediate message_end with only thinking blocks', () => {
      const lines = [
        // First message_end has only thinking — should be skipped entirely
        JSON.stringify({
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'thinking', text: 'reasoning...' }] },
        }),
        // Second message_end has text — this is the last with text, so returned
        JSON.stringify({
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Final answer.' }] },
        }),
      ];
      const rawOutput = lines.join('\n');
      const result = piBackend.parseResult(rawOutput);
      expect(result.text).toBe('Final answer.');
    });

    it('ignores the echoed user message_end (pi emits one per message, including the prompt)', () => {
      const lines = [
        JSON.stringify({
          type: 'message_end',
          message: { role: 'user', content: [{ type: 'text', text: 'run the daily skill' }] },
        }),
        JSON.stringify({
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Done, here it is.' }] },
        }),
      ];
      const result = piBackend.parseResult(lines.join('\n'));
      expect(result.text).toBe('Done, here it is.');
    });

    it('does NOT parrot the user prompt when the assistant errored with empty content', () => {
      const lines = [
        JSON.stringify({
          type: 'message_end',
          message: { role: 'user', content: [{ type: 'text', text: 'the skill prompt' }] },
        }),
        JSON.stringify({
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage: '429 quota exceeded\n',
          },
        }),
      ];
      const result = piBackend.parseResult(lines.join('\n'));
      expect(result.text).toBeNull();
      expect(result.errorMessage).toBe('429 quota exceeded');
    });

    it('prefers real assistant text over an earlier errored attempt (auto-retry succeeded)', () => {
      const lines = [
        JSON.stringify({
          type: 'message_end',
          message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        }),
        JSON.stringify({
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage: '429 quota exceeded\n',
          },
        }),
        JSON.stringify({
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] },
        }),
      ];
      const result = piBackend.parseResult(lines.join('\n'));
      expect(result.text).toBe('Hi there!');
    });

    it('returns null text when only a user message_end is present', () => {
      const rawOutput = JSON.stringify({
        type: 'message_end',
        message: { role: 'user', content: [{ type: 'text', text: 'just the prompt' }] },
      });
      const result = piBackend.parseResult(rawOutput);
      expect(result.text).toBeNull();
    });
  });

  describe('extractStreamDelta', () => {
    it('returns text delta from message_update with text_delta', () => {
      const line = JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
      });
      const result = piBackend.extractStreamDelta(line);
      expect(result).toEqual({ type: 'text', text: 'Hello' });
    });

    it('returns thinking delta from message_update with thinking_delta', () => {
      const line = JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', delta: 'Let me think...' },
      });
      const result = piBackend.extractStreamDelta(line);
      expect(result).toEqual({ type: 'thinking', thinking: 'Let me think...' });
    });

    it('returns block_start thinking from thinking_start event', () => {
      const line = JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_start' },
      });
      const result = piBackend.extractStreamDelta(line);
      expect(result).toEqual({ type: 'block_start', blockType: 'thinking' });
    });

    it('returns block_start text from text_start event', () => {
      const line = JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_start' },
      });
      const result = piBackend.extractStreamDelta(line);
      expect(result).toEqual({ type: 'block_start', blockType: 'text' });
    });

    it('returns null for non-message_update lines', () => {
      const sessionLine = JSON.stringify({ type: 'session', id: 'abc' });
      expect(piBackend.extractStreamDelta(sessionLine)).toBeNull();

      const messageEndLine = JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      });
      expect(piBackend.extractStreamDelta(messageEndLine)).toBeNull();
    });

    it('returns null for empty lines', () => {
      expect(piBackend.extractStreamDelta('')).toBeNull();
      expect(piBackend.extractStreamDelta('   ')).toBeNull();
      expect(piBackend.extractStreamDelta('\n')).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      expect(piBackend.extractStreamDelta('not json at all')).toBeNull();
      expect(piBackend.extractStreamDelta('{broken')).toBeNull();
    });

    it('handles text_delta with empty delta', () => {
      const line = JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta' },
      });
      const result = piBackend.extractStreamDelta(line);
      expect(result).toEqual({ type: 'text', text: '' });
    });
  });

  describe('extractSessionId', () => {
    it('extracts id from session type line', () => {
      const line = JSON.stringify({ type: 'session', id: 'uuid-session-456' });
      const result = piBackend.extractSessionId(line);
      expect(result).toBe('uuid-session-456');
    });

    it('returns null for non-session lines', () => {
      const updateLine = JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'hi' },
      });
      expect(piBackend.extractSessionId(updateLine)).toBeNull();

      const endLine = JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', content: [] },
      });
      expect(piBackend.extractSessionId(endLine)).toBeNull();
    });

    it('returns null for empty lines', () => {
      expect(piBackend.extractSessionId('')).toBeNull();
      expect(piBackend.extractSessionId('  ')).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      expect(piBackend.extractSessionId('not-json')).toBeNull();
    });

    it('returns null for session-like object without id field', () => {
      const line = JSON.stringify({ type: 'session', name: 'foo' });
      expect(piBackend.extractSessionId(line)).toBeNull();
    });
  });
});
