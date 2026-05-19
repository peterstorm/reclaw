import type { AppConfig } from '../config.js';
import type { AgentBackend } from './types.js';
import { claudeBackend } from './claude-backend.js';
import { piBackend } from './pi-backend.js';

export function resolveBackend(config: Pick<AppConfig, 'agentBackend'>): AgentBackend {
  switch (config.agentBackend) {
    case 'pi': return piBackend;
    case 'claude': return claudeBackend;
    default: {
      const _exhaustive: never = config.agentBackend;
      throw new Error(`Unknown backend: ${_exhaustive}`);
    }
  }
}

export { runAgent, runAgentStreaming } from './runner.js';
export type { AgentBackend, AgentOptions, AgentResult, StreamDelta, StreamChunk, OnStreamChunk, SpawnFn } from './types.js';
export { claudeBackend } from './claude-backend.js';
export { piBackend } from './pi-backend.js';
