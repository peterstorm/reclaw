import { describe, expect, it } from 'vitest';
import {
  type SkillEnvironmentVariable,
  buildAgentProcessEnvironment,
  resolveSkillEnvironment,
} from './agent-environment.js';

describe('buildAgentProcessEnvironment', () => {
  it('keeps required runtime and agent-provider variables', () => {
    const result = buildAgentProcessEnvironment(
      {
        HOME: '/home/reclaw',
        PATH: '/run/current-system/sw/bin',
        NIX_PROFILES: '/nix/profile',
        GEMINI_API_KEY: 'provider-key',
        DEEPSEEK_API_KEY: 'unselected-provider-key',
      },
      { backend: 'pi', provider: 'google' },
    );

    expect(result).toEqual({
      HOME: '/home/reclaw',
      PATH: '/run/current-system/sw/bin',
      NIX_PROFILES: '/nix/profile',
      GEMINI_API_KEY: 'provider-key',
    });
  });

  it('retains documented provider keys when Pi selects its provider from settings', () => {
    const result = buildAgentProcessEnvironment(
      {
        GEMINI_API_KEY: 'gemini-key',
        DEEPSEEK_API_KEY: 'deepseek-key',
        TELEGRAM_TOKEN: 'not-a-provider-key',
      },
      { backend: 'pi' },
    );

    expect(result).toEqual({
      GEMINI_API_KEY: 'gemini-key',
      DEEPSEEK_API_KEY: 'deepseek-key',
    });
  });

  it('passes only Claude authentication values to the Claude backend', () => {
    const result = buildAgentProcessEnvironment(
      {
        ANTHROPIC_API_KEY: 'anthropic-key',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
        GEMINI_API_KEY: 'unrelated-provider-key',
      },
      { backend: 'claude' },
    );

    expect(result).toEqual({
      ANTHROPIC_API_KEY: 'anthropic-key',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
    });
  });

  it('drops Reclaw service credentials by default', () => {
    const result = buildAgentProcessEnvironment(
      {
        PATH: '/bin',
        TELEGRAM_TOKEN: 'telegram-secret',
        NOTEBOOKLM_AUTH_TOKEN: 'notebook-secret',
        NOTEBOOKLM_COOKIES: 'cookie-secret',
        GOOGLE_PASSWORD: 'google-secret',
        GARMIN_PASSWORD: 'garmin-secret',
        OBSIDIAN_VAULT_PATH: '/private/vault',
        SSH_AUTH_SOCK: '/run/user/1000/ssh-agent',
      },
      { backend: 'claude' },
    );

    expect(result).toEqual({ PATH: '/bin' });
  });

  it('copies explicit grants and lets them override baseline values', () => {
    const result = buildAgentProcessEnvironment(
      { PATH: '/inherited/bin', TELEGRAM_TOKEN: 'not-granted' },
      { backend: 'claude' },
      { PATH: '/explicit/bin', GARMIN_EMAIL: 'runner@example.com' },
    );

    expect(result).toEqual({
      PATH: '/explicit/bin',
      GARMIN_EMAIL: 'runner@example.com',
    });
  });

  it('omits undefined values', () => {
    const result = buildAgentProcessEnvironment(
      {
        HOME: undefined,
        PATH: '/bin',
        ANTHROPIC_API_KEY: undefined,
      },
      { backend: 'claude' },
    );

    expect(result).toEqual({ PATH: '/bin' });
    expect(Object.values(result)).not.toContain(undefined);
  });

  it('does not mutate either input', () => {
    const inherited = { PATH: '/bin', TELEGRAM_TOKEN: 'secret' };
    const explicit = { GARMIN_EMAIL: 'runner@example.com' };

    const result = buildAgentProcessEnvironment(inherited, { backend: 'claude' }, explicit);
    result.PATH = '/changed';

    expect(inherited).toEqual({ PATH: '/bin', TELEGRAM_TOKEN: 'secret' });
    expect(explicit).toEqual({ GARMIN_EMAIL: 'runner@example.com' });
  });
});

describe('resolveSkillEnvironment', () => {
  it('returns only values named by parsed grants', () => {
    const grants: readonly SkillEnvironmentVariable[] = ['GARMIN_EMAIL', 'GARMIN_PASSWORD'];
    const result = resolveSkillEnvironment(
      {
        GARMIN_EMAIL: 'runner@example.com',
        GARMIN_PASSWORD: 'garmin-secret',
        GOOGLE_PASSWORD: 'google-secret',
        TELEGRAM_TOKEN: 'telegram-secret',
      },
      grants,
    );

    expect(result).toEqual({
      GARMIN_EMAIL: 'runner@example.com',
      GARMIN_PASSWORD: 'garmin-secret',
    });
  });

  it('omits a granted variable when it is not configured', () => {
    const result = resolveSkillEnvironment({}, ['GARMIN_EMAIL']);
    expect(result).toEqual({});
  });

  it('returns an empty environment for a skill with no grants', () => {
    const result = resolveSkillEnvironment(
      { GARMIN_EMAIL: 'runner@example.com', PATH: '/bin' },
      [],
    );
    expect(result).toEqual({});
  });
});
