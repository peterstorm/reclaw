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
        '--dangerously-skip-permissions',
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

    it('omits --allowedTools flag when allowedTools is empty', () => {
      const args = claudeBackend.buildArgs({ allowedTools: [] });

      expect(args).toContain('--dangerously-skip-permissions');
      expect(args).not.toContain('--allowedTools');
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
    it('extracts text from result line', () => {
      const rawOutput = JSON.stringify({ type: 'result', result: 'Hello world', session_id: 'sess-1' });

      const { text } = claudeBackend.parseResult(rawOutput);
      expect(text).toBe('Hello world');
    });

    it('extracts sessionId from result line', () => {
      const rawOutput = JSON.stringify({ type: 'result', result: 'Hello', session_id: 'sess-abc-123' });

      const { sessionId } = claudeBackend.parseResult(rawOutput);
      expect(sessionId).toBe('sess-abc-123');
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

      const { text, sessionId } = claudeBackend.parseResult(rawOutput);
      expect(text).toBe('Final answer');
      expect(sessionId).toBe('sess-xyz');
    });

    it('returns nulls when no result line exists', () => {
      const rawOutput = [
        '{"type":"stream_event","event":{}}',
        'some random text',
        '',
      ].join('\n');

      const { text, sessionId } = claudeBackend.parseResult(rawOutput);
      expect(text).toBeNull();
      expect(sessionId).toBeNull();
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
