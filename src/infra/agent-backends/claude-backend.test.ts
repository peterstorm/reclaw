import { describe, expect, it } from 'vitest';
import { claudeBackend } from './claude-backend.js';

describe('claudeBackend', () => {
  describe('buildArgs', () => {
    it('produces correct flags without session', () => {
      const args = claudeBackend.buildArgs({
        allowedTools: ['Read', 'Write', 'Bash'],
      });

      expect(args).toEqual([
        'claude',
        '-p',
        '--output-format',
        'stream-json',
        '--include-partial-messages',
        '--permission-mode',
        'dontAsk',
        '--tools',
        'Read,Write,Bash',
        '--allowedTools',
        'Read,Write,Bash',
      ]);
    });

    it('includes --resume before the session id when session provided', () => {
      const args = claudeBackend.buildArgs({
        resumeSessionId: 'sess-abc-123',
        allowedTools: ['Read'],
      });

      const resumeIdx = args.indexOf('--resume');
      expect(resumeIdx).toBeGreaterThan(-1);
      expect(args[resumeIdx + 1]).toBe('sess-abc-123');
    });

    it('formats allowedTools as comma-separated in --allowedTools', () => {
      const args = claudeBackend.buildArgs({
        allowedTools: ['Read', 'Write', 'Bash', 'recall', 'remember'],
      });

      const toolsIdx = args.indexOf('--allowedTools');
      expect(toolsIdx).toBeGreaterThan(-1);
      expect(args[toolsIdx + 1]).toBe('Read,Write,Bash,recall,remember');
    });

    it('disables all tools and permission prompts when allowedTools is empty', () => {
      const args = claudeBackend.buildArgs({ allowedTools: [] });

      expect(args).toContain('--permission-mode');
      expect(args).toContain('dontAsk');
      expect(args).not.toContain('--dangerously-skip-permissions');
      expect(args).not.toContain('--allowedTools');
      expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual([
        '--tools',
        '',
      ]);
    });

    it('limits Claude built-ins separately from extension and alternate-backend tools', () => {
      const args = claudeBackend.buildArgs({
        allowedTools: ['Read', 'Bash', 'subagent', 'recall', 'remember'],
      });

      expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual([
        '--tools',
        'Read,Bash',
      ]);
      expect(
        args.slice(args.indexOf('--allowedTools'), args.indexOf('--allowedTools') + 2),
      ).toEqual(['--allowedTools', 'Read,Bash,subagent,recall,remember']);
    });

    it('enables the native editing, skill, and delegation tools used by interactive chat', () => {
      const args = claudeBackend.buildArgs({
        allowedTools: [
          'Read',
          'Write',
          'Edit',
          'Bash',
          'Glob',
          'Grep',
          'Task',
          'Skill',
          'TodoWrite',
          'NotebookEdit',
          'subagent',
        ],
      });

      expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual([
        '--tools',
        'Read,Write,Edit,Bash,Glob,Grep,Task,Skill,TodoWrite,NotebookEdit',
      ]);
    });

    it('enables a built-in family once while preserving selectors for permission checks', () => {
      const args = claudeBackend.buildArgs({
        allowedTools: ['WebSearch(*)', 'WebSearch', 'Bash(git:*)'],
      });

      expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual([
        '--tools',
        'WebSearch,Bash',
      ]);
      expect(
        args.slice(args.indexOf('--allowedTools'), args.indexOf('--allowedTools') + 2),
      ).toEqual(['--allowedTools', 'WebSearch(*),WebSearch,Bash(git:*)']);
    });
  });

  describe('cleanEnv', () => {
    it('removes CLAUDECODE and CLAUDE_CODE_ENTRYPOINT', () => {
      const env = {
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        HOME: '/home/user',
        PATH: '/usr/bin',
      };

      const cleaned = claudeBackend.cleanEnv(env);

      expect(cleaned).not.toHaveProperty('CLAUDECODE');
      expect(cleaned).not.toHaveProperty('CLAUDE_CODE_ENTRYPOINT');
    });

    it('preserves other env vars unchanged', () => {
      const env = {
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        HOME: '/home/user',
        PATH: '/usr/bin',
        CUSTOM_VAR: 'value',
      };

      const cleaned = claudeBackend.cleanEnv(env);

      expect(cleaned).toEqual({
        HOME: '/home/user',
        PATH: '/usr/bin',
        CUSTOM_VAR: 'value',
      });
    });
  });

  describe('parseResult', () => {
    it('extracts text from result line when no streaming events present (fallback)', () => {
      const rawOutput = JSON.stringify({
        type: 'result',
        result: 'Hello world',
        session_id: 'sess-1',
      });

      const { text } = claudeBackend.parseResult(rawOutput);
      expect(text).toBe('Hello world');
    });

    it('extracts sessionId from result line', () => {
      const rawOutput = JSON.stringify({
        type: 'result',
        result: 'Hello',
        session_id: 'sess-abc-123',
      });

      const { sessionId } = claudeBackend.parseResult(rawOutput);
      expect(sessionId).toBe('sess-abc-123');
    });

    it('returns only LAST message text when multiple messages exist (tool use)', () => {
      // Simulates: message 1 has "Let me check..." (intermediate), message 2 has "Done." (final)
      const rawOutput = [
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'message_start', message: { id: 'msg1', role: 'assistant' } },
        }),
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
        }),
        JSON.stringify({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'I need to check...' },
          },
        }),
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
        }),
        JSON.stringify({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'text_delta', text: 'Let me check the config...' },
          },
        }),
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use' } },
        }),
        // Tool result comes back, then new message:
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'message_start', message: { id: 'msg2', role: 'assistant' } },
        }),
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        }),
        JSON.stringify({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Done. Here is your answer.' },
          },
        }),
        JSON.stringify({
          type: 'result',
          result: 'Let me check the config...\n\nDone. Here is your answer.',
          session_id: 'sess-xyz',
        }),
      ].join('\n');

      const { text, sessionId } = claudeBackend.parseResult(rawOutput);
      expect(text).toBe('Done. Here is your answer.');
      expect(sessionId).toBe('sess-xyz');
    });

    it('returns only LAST message text with multiple tool-use rounds', () => {
      const rawOutput = [
        // Message 1: intermediate
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'message_start', message: { id: 'msg1', role: 'assistant' } },
        }),
        JSON.stringify({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Step 1...' },
          },
        }),
        // Message 2: intermediate
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'message_start', message: { id: 'msg2', role: 'assistant' } },
        }),
        JSON.stringify({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Step 2...' },
          },
        }),
        // Message 3: final
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'message_start', message: { id: 'msg3', role: 'assistant' } },
        }),
        JSON.stringify({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Final ' },
          },
        }),
        JSON.stringify({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'answer.' },
          },
        }),
        JSON.stringify({
          type: 'result',
          result: 'Step 1...\nStep 2...\nFinal answer.',
          session_id: 'sess-multi',
        }),
      ].join('\n');

      const { text } = claudeBackend.parseResult(rawOutput);
      expect(text).toBe('Final answer.');
    });

    it('handles single message correctly (no tool use)', () => {
      const rawOutput = [
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'message_start', message: { id: 'msg1', role: 'assistant' } },
        }),
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
        }),
        JSON.stringify({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'thinking...' },
          },
        }),
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
        }),
        JSON.stringify({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'text_delta', text: 'Here is the answer.' },
          },
        }),
        JSON.stringify({ type: 'result', result: 'Here is the answer.', session_id: 'sess-1' }),
      ].join('\n');

      const { text } = claudeBackend.parseResult(rawOutput);
      expect(text).toBe('Here is the answer.');
    });

    it('handles multi-line output with non-JSON lines', () => {
      const rawOutput = [
        'some debug output',
        '{"type":"stream_event","event":{"type":"content_block_delta"}}',
        '',
        'not json at all',
        JSON.stringify({ type: 'result', result: 'Final answer', session_id: 'sess-xyz' }),
        '',
      ].join('\n');

      // No message_start events → falls back to result field
      const { text, sessionId } = claudeBackend.parseResult(rawOutput);
      expect(text).toBe('Final answer');
      expect(sessionId).toBe('sess-xyz');
    });

    it('returns nulls when no result line exists', () => {
      const rawOutput = ['{"type":"stream_event","event":{}}', 'some random text', ''].join('\n');

      const { text, sessionId } = claudeBackend.parseResult(rawOutput);
      expect(text).toBeNull();
      expect(sessionId).toBeNull();
    });

    it('ignores thinking deltas when accumulating per-message text', () => {
      const rawOutput = [
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'message_start', message: { id: 'msg1', role: 'assistant' } },
        }),
        JSON.stringify({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'internal reasoning' },
          },
        }),
        JSON.stringify({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'text_delta', text: 'visible response' },
          },
        }),
        JSON.stringify({ type: 'result', result: 'visible response', session_id: 'sess-1' }),
      ].join('\n');

      const { text } = claudeBackend.parseResult(rawOutput);
      expect(text).toBe('visible response');
    });

    it('returns null text when last message has no text content', () => {
      const rawOutput = [
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'message_start', message: { id: 'msg1', role: 'assistant' } },
        }),
        JSON.stringify({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'intermediate' },
          },
        }),
        // Second message with only thinking (edge case)
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'message_start', message: { id: 'msg2', role: 'assistant' } },
        }),
        JSON.stringify({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'hmm' },
          },
        }),
        JSON.stringify({ type: 'result', result: 'intermediate', session_id: 'sess-1' }),
      ].join('\n');

      const { text } = claudeBackend.parseResult(rawOutput);
      // Last message had no text_delta, so text is null
      expect(text).toBeNull();
    });

    it('captures errorMessage from an is_error result frame and does not treat it as text', () => {
      const rawOutput = JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: 'Credit balance is too low',
        session_id: 'sess-err',
      });

      const { text, errorMessage, sessionId } = claudeBackend.parseResult(rawOutput);
      expect(text).toBeNull();
      expect(errorMessage).toBe('Credit balance is too low');
      expect(sessionId).toBe('sess-err');
    });

    it('falls back to subtype when an error frame has no result text', () => {
      const rawOutput = JSON.stringify({
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        session_id: 'sess-err2',
      });

      const { text, errorMessage } = claudeBackend.parseResult(rawOutput);
      expect(text).toBeNull();
      expect(errorMessage).toBe('error_max_turns');
    });

    it('leaves errorMessage null on a successful result frame', () => {
      const rawOutput = JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'All good',
        session_id: 'sess-ok',
      });

      const { text, errorMessage } = claudeBackend.parseResult(rawOutput);
      expect(text).toBe('All good');
      expect(errorMessage).toBeNull();
    });
  });

  describe('extractStreamDelta', () => {
    it('handles thinking_delta', () => {
      const line = JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'thinking_delta', thinking: 'Let me think...' },
        },
      });

      const delta = claudeBackend.extractStreamDelta(line);
      expect(delta).toEqual({ type: 'thinking', thinking: 'Let me think...' });
    });

    it('handles text_delta', () => {
      const line = JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Here is my response' },
        },
      });

      const delta = claudeBackend.extractStreamDelta(line);
      expect(delta).toEqual({ type: 'text', text: 'Here is my response' });
    });

    it('handles content_block_start for thinking', () => {
      const line = JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'thinking' },
        },
      });

      const delta = claudeBackend.extractStreamDelta(line);
      expect(delta).toEqual({ type: 'block_start', blockType: 'thinking' });
    });

    it('handles content_block_start for text', () => {
      const line = JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'text' },
        },
      });

      const delta = claudeBackend.extractStreamDelta(line);
      expect(delta).toEqual({ type: 'block_start', blockType: 'text' });
    });

    it('returns null for non-stream_event lines', () => {
      const line = JSON.stringify({ type: 'result', result: 'done', session_id: 's1' });

      const delta = claudeBackend.extractStreamDelta(line);
      expect(delta).toBeNull();
    });

    it('returns null for empty/whitespace lines', () => {
      expect(claudeBackend.extractStreamDelta('')).toBeNull();
      expect(claudeBackend.extractStreamDelta('   ')).toBeNull();
      expect(claudeBackend.extractStreamDelta('\n')).toBeNull();
    });
  });

  describe('extractSessionId', () => {
    it('extracts session_id from result line', () => {
      const line = JSON.stringify({ type: 'result', result: 'text', session_id: 'sess-final-id' });

      const sessionId = claudeBackend.extractSessionId(line);
      expect(sessionId).toBe('sess-final-id');
    });

    it('returns null for non-result lines', () => {
      const streamLine = JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
      });
      expect(claudeBackend.extractSessionId(streamLine)).toBeNull();

      expect(claudeBackend.extractSessionId('not json')).toBeNull();
      expect(claudeBackend.extractSessionId('')).toBeNull();
    });
  });
});
