import type { AppConfig } from '../config.js';

/** A complete, valid AppConfig for handler tests; override only what the test is about. */
export const makeAppConfig = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  telegramToken: 'tok',
  authorizedUserIds: [123],
  redisHost: 'localhost',
  redisPort: 6379,
  workspacePath: '/workspace',
  skillsDir: '/workspace/skills',
  personalityPath: '/workspace/personality.md',
  chatTimeoutMs: 3_600_000,
  scheduledTimeoutMs: 300_000,
  latitude: 55.665,
  longitude: 12.57,
  timezone: 'Europe/Copenhagen',
  locationName: 'Copenhagen',
  agentBackend: 'claude',
  agentContainment: { kind: 'none' },
  ...overrides,
});
