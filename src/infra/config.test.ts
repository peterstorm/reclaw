import { describe, expect, it } from 'vitest';
import { parseEnvToRaw, loadConfig } from './config.js';

const VALID_ENV = {
  TELEGRAM_TOKEN: 'bot123:ABC',
  AUTHORIZED_USER_IDS: '42',
};

describe('parseEnvToRaw', () => {
  it('maps env vars to raw object', () => {
    const { raw, errors } = parseEnvToRaw({
      ...VALID_ENV,
      REDIS_HOST: 'redis.local',
      REDIS_PORT: '6380',
      CHAT_TIMEOUT_MS: '60000',
      SCHEDULED_TIMEOUT_MS: '180000',
    });
    expect(errors).toHaveLength(0);
    expect(raw['telegramToken']).toBe('bot123:ABC');
    expect(raw['authorizedUserIds']).toEqual([42]);
    expect(raw['redisHost']).toBe('redis.local');
    expect(raw['redisPort']).toBe(6380);
    expect(raw['chatTimeoutMs']).toBe(60000);
    expect(raw['scheduledTimeoutMs']).toBe(180000);
  });

  it('returns undefined for missing optional numerics', () => {
    const { raw, errors } = parseEnvToRaw(VALID_ENV);
    expect(errors).toHaveLength(0);
    expect(raw['redisPort']).toBeUndefined();
    expect(raw['chatTimeoutMs']).toBeUndefined();
  });

  it('collects error for non-integer REDIS_PORT', () => {
    const { raw, errors } = parseEnvToRaw({ ...VALID_ENV, REDIS_PORT: 'abc' });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('REDIS_PORT');
    expect(raw['redisPort']).toBeUndefined();
  });

  it('collects error for float REDIS_PORT', () => {
    const { raw, errors } = parseEnvToRaw({ ...VALID_ENV, REDIS_PORT: '6379.9' });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('REDIS_PORT');
    expect(raw['redisPort']).toBeUndefined();
  });
});

describe('loadConfig', () => {
  it('returns ok with valid env', () => {
    const result = loadConfig(VALID_ENV);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.telegramToken).toBe('bot123:ABC');
      expect(result.value.authorizedUserIds).toEqual([42]);
    }
  });

  it('applies defaults', () => {
    const result = loadConfig(VALID_ENV);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.redisHost).toBe('localhost');
      expect(result.value.redisPort).toBe(6379);
      expect(result.value.workspacePath).toBe('/workspace');
      expect(result.value.skillsDir).toBe('/workspace/skills');
      expect(result.value.personalityPath).toBe('/workspace/personality.md');
      expect(result.value.claudeBinaryPath).toBe('claude');
      expect(result.value.chatTimeoutMs).toBe(120_000);
      expect(result.value.scheduledTimeoutMs).toBe(300_000);
      expect(result.value.sessionIdleTimeoutMs).toBe(1_800_000);
    }
  });

  it('returns err when TELEGRAM_TOKEN missing', () => {
    const result = loadConfig({ AUTHORIZED_USER_ID: '42' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('telegramToken');
    }
  });

  it('returns err when AUTHORIZED_USER_IDS missing', () => {
    const result = loadConfig({ TELEGRAM_TOKEN: 'bot123:ABC' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('authorizedUserIds');
    }
  });

  it('returns err when AUTHORIZED_USER_IDS contains non-number', () => {
    const result = loadConfig({ ...VALID_ENV, AUTHORIZED_USER_IDS: 'not-a-number' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('AUTHORIZED_USER_IDS');
    }
  });

  it('returns err when AUTHORIZED_USER_IDS contains zero', () => {
    const result = loadConfig({ ...VALID_ENV, AUTHORIZED_USER_IDS: '0' });
    expect(result.ok).toBe(false);
  });

  it('returns err when AUTHORIZED_USER_IDS contains negative', () => {
    const result = loadConfig({ ...VALID_ENV, AUTHORIZED_USER_IDS: '-5' });
    expect(result.ok).toBe(false);
  });

  it('parses comma-separated AUTHORIZED_USER_IDS', () => {
    const result = loadConfig({ ...VALID_ENV, AUTHORIZED_USER_IDS: '42,99,7' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.authorizedUserIds).toEqual([42, 99, 7]);
    }
  });

  it('returns err when any entry in AUTHORIZED_USER_IDS is invalid', () => {
    const result = loadConfig({ ...VALID_ENV, AUTHORIZED_USER_IDS: '42,bad,7' });
    expect(result.ok).toBe(false);
  });

  it('returns err when REDIS_PORT is not a valid integer', () => {
    const result = loadConfig({ ...VALID_ENV, REDIS_PORT: 'abc' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('REDIS_PORT');
    }
  });

  it('returns err when REDIS_PORT is a float', () => {
    const result = loadConfig({ ...VALID_ENV, REDIS_PORT: '6379.9' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('REDIS_PORT');
    }
  });

  it('returns ok when REDIS_PORT is valid integer', () => {
    const result = loadConfig({ ...VALID_ENV, REDIS_PORT: '6380' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.redisPort).toBe(6380);
    }
  });

  it('returns err when REDIS_PORT is out of range (0)', () => {
    const result = loadConfig({ ...VALID_ENV, REDIS_PORT: '0' });
    expect(result.ok).toBe(false);
  });

  it('returns err when REDIS_PORT is out of range (65536)', () => {
    const result = loadConfig({ ...VALID_ENV, REDIS_PORT: '65536' });
    expect(result.ok).toBe(false);
  });

  it('overrides defaults when env vars provided', () => {
    const result = loadConfig({
      ...VALID_ENV,
      REDIS_HOST: 'myredis',
      REDIS_PORT: '6380',
      WORKSPACE_PATH: '/custom',
      SKILLS_DIR: '/custom/skills',
      PERSONALITY_PATH: '/custom/personality.md',
      CLAUDE_BINARY_PATH: '/usr/bin/claude',
      CHAT_TIMEOUT_MS: '60000',
      SCHEDULED_TIMEOUT_MS: '180000',
      SESSION_IDLE_TIMEOUT_MS: '900000',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.redisHost).toBe('myredis');
      expect(result.value.redisPort).toBe(6380);
      expect(result.value.workspacePath).toBe('/custom');
      expect(result.value.skillsDir).toBe('/custom/skills');
      expect(result.value.personalityPath).toBe('/custom/personality.md');
      expect(result.value.claudeBinaryPath).toBe('/usr/bin/claude');
      expect(result.value.chatTimeoutMs).toBe(60000);
      expect(result.value.scheduledTimeoutMs).toBe(180000);
      expect(result.value.sessionIdleTimeoutMs).toBe(900000);
    }
  });

  it('handles optional fields', () => {
    const result = loadConfig({
      ...VALID_ENV,
      OBSIDIAN_VAULT_PATH: '/vaults/main',
      GEMINI_API_KEY: 'gemini-key-abc',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.obsidianVaultPath).toBe('/vaults/main');
      expect(result.value.geminiApiKey).toBe('gemini-key-abc');
    }
  });

  it('optional fields are undefined when not set', () => {
    const result = loadConfig(VALID_ENV);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.obsidianVaultPath).toBeUndefined();
      expect(result.value.geminiApiKey).toBeUndefined();
    }
  });

  it('returns err when TELEGRAM_TOKEN is empty string', () => {
    const result = loadConfig({ ...VALID_ENV, TELEGRAM_TOKEN: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('telegramToken');
    }
  });
});
