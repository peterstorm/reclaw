import { describe, expect, it } from 'vitest';
import { parseSkillConfig, parseSkillDirectory } from './skill-config.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function validYaml(overrides: Record<string, unknown> = {}): string {
  const base = {
    name: 'Morning Briefing',
    schedule: '0 8 * * *',
    promptTemplate: 'Good morning! Today is {{date}}.',
    permissionProfile: 'scheduled',
    validityWindowMinutes: 30,
    timeout: 120,
    ...overrides,
  };
  // Build minimal YAML manually to avoid extra deps in tests
  return Object.entries(base)
    .map(([k, v]) => {
      if (typeof v === 'string') return `${k}: "${v}"`;
      if (v === null) return `${k}: null`;
      return `${k}: ${v}`;
    })
    .join('\n');
}

// ─── parseSkillConfig ─────────────────────────────────────────────────────────

describe('parseSkillConfig', () => {
  it('parses a valid YAML skill config', () => {
    const yaml = validYaml();
    const result = parseSkillConfig(yaml, '/workspace/skills/morning-briefing.yaml');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe('morning-briefing');
      expect(result.value.name).toBe('Morning Briefing');
      expect(result.value.schedule).toBe('0 8 * * *');
      expect(result.value.promptTemplate).toBe('Good morning! Today is {{date}}.');
      expect(result.value.permissionProfile).toBe('scheduled');
      expect(result.value.validityWindowMinutes).toBe(30);
      expect(result.value.timeout).toBe(120);
    }
  });

  it('derives skill id from filename without extension', () => {
    const yaml = validYaml();
    const result = parseSkillConfig(yaml, '/skills/hn-ai-digest.yaml');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.id).toBe('hn-ai-digest');
  });

  it('derives skill id from .yml extension too', () => {
    const yaml = validYaml();
    const result = parseSkillConfig(yaml, '/skills/my-skill.yml');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.id).toBe('my-skill');
  });

  it('applies default validityWindowMinutes of 30', () => {
    // Field omitted from YAML — test with minimal valid YAML
    const r2 = parseSkillConfig(
      'name: "Test"\npromptTemplate: "Do it"\npermissionProfile: "chat"',
      '/skills/test-skill.yaml',
    );
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value.validityWindowMinutes).toBe(30);
  });

  it('applies default timeout of 120', () => {
    const r = parseSkillConfig(
      'name: "Test"\npromptTemplate: "Do it"\npermissionProfile: "chat"',
      '/skills/test-skill.yaml',
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.timeout).toBe(120);
  });

  it('accepts null schedule (on-demand only)', () => {
    const yaml = validYaml({ schedule: null });
    const result = parseSkillConfig(yaml, '/skills/ondemand.yaml');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.schedule).toBeNull();
  });

  it('accepts chat as permissionProfile', () => {
    const yaml = validYaml({ permissionProfile: 'chat' });
    const result = parseSkillConfig(yaml, '/skills/chat-skill.yaml');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.permissionProfile).toBe('chat');
  });

  it('returns error for invalid YAML syntax', () => {
    const result = parseSkillConfig('invalid: yaml: [unclosed', '/skills/broken.yaml');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('broken.yaml');
  });

  it('returns error for non-object YAML (scalar)', () => {
    const result = parseSkillConfig('"just a string"', '/skills/scalar.yaml');
    expect(result.ok).toBe(false);
  });

  it('returns error when name is missing', () => {
    const result = parseSkillConfig(
      'promptTemplate: "Do it"\npermissionProfile: "chat"',
      '/skills/noname.yaml',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('name');
  });

  it('returns error when promptTemplate is missing', () => {
    const result = parseSkillConfig(
      'name: "Test"\npermissionProfile: "chat"',
      '/skills/noprompt.yaml',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('promptTemplate');
  });

  it('returns error for invalid permissionProfile value', () => {
    const yaml = validYaml({ permissionProfile: 'admin' });
    const result = parseSkillConfig(yaml, '/skills/bad-profile.yaml');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('permissionProfile');
  });

  it('returns error for negative validityWindowMinutes', () => {
    const yaml = validYaml({ validityWindowMinutes: -5 });
    const result = parseSkillConfig(yaml, '/skills/neg-window.yaml');
    expect(result.ok).toBe(false);
  });

  it('returns error for zero timeout', () => {
    const yaml = validYaml({ timeout: 0 });
    const result = parseSkillConfig(yaml, '/skills/zero-timeout.yaml');
    expect(result.ok).toBe(false);
  });

  it('returns error when skill id would be empty (no filename)', () => {
    const yaml = validYaml();
    const result = parseSkillConfig(yaml, '.yaml');
    // id derived is '' — should fail makeSkillId
    expect(result.ok).toBe(false);
  });

  it('rejects invalid cron expression "not a cron"', () => {
    const yaml = validYaml({ schedule: 'not a cron' });
    const result = parseSkillConfig(yaml, '/skills/bad-cron.yaml');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('cron');
  });

  it('rejects out-of-range cron "60 * * * *"', () => {
    const yaml = validYaml({ schedule: '60 * * * *' });
    const result = parseSkillConfig(yaml, '/skills/bad-cron2.yaml');
    expect(result.ok).toBe(false);
  });

  it('accepts valid cron "0 8 * * *"', () => {
    const yaml = validYaml({ schedule: '0 8 * * *' });
    const result = parseSkillConfig(yaml, '/skills/good-cron.yaml');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.schedule).toBe('0 8 * * *');
  });

  it('defaults dependsOn to null when omitted', () => {
    const yaml = validYaml();
    const result = parseSkillConfig(yaml, '/skills/no-dep.yaml');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.dependsOn).toBeNull();
  });

  it('parses valid dependsOn with null schedule', () => {
    const yaml = validYaml({ schedule: null, dependsOn: 'cortex-prune' });
    const result = parseSkillConfig(yaml, '/skills/librarian.yaml');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.dependsOn).toBe('cortex-prune');
      expect(result.value.schedule).toBeNull();
    }
  });

  it('rejects skill with both schedule and dependsOn', () => {
    const yaml = validYaml({ schedule: '0 8 * * *', dependsOn: 'cortex-prune' });
    const result = parseSkillConfig(yaml, '/skills/both.yaml');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('dependsOn');
  });

  it('rejects self-dependency (dependsOn equals own id)', () => {
    const yaml = validYaml({ schedule: null, dependsOn: 'self-ref' });
    const result = parseSkillConfig(yaml, '/skills/self-ref.yaml');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('cannot depend on itself');
  });

  it('rejects dependsOn with path separators', () => {
    const yaml = validYaml({ schedule: null, dependsOn: 'bad/path' });
    const result = parseSkillConfig(yaml, '/skills/badpath.yaml');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('path separator');
  });
});

// ─── parseSkillDirectory ──────────────────────────────────────────────────────

describe('parseSkillDirectory', () => {
  const goodFile = {
    path: '/skills/morning-briefing.yaml',
    content: validYaml(),
  };
  const badFile = {
    path: '/skills/broken.yaml',
    content: 'not: valid: yaml: [unclosed',
  };

  it('returns all valid skills when all files parse correctly', () => {
    const second = {
      path: '/skills/hn-digest.yaml',
      content: validYaml({ name: 'HN Digest' }),
    };
    const { valid, errors } = parseSkillDirectory([goodFile, second]);
    expect(valid.length).toBe(2);
    expect(errors.length).toBe(0);
  });

  it('collects errors without crashing (FR-054)', () => {
    const { valid, errors } = parseSkillDirectory([goodFile, badFile]);
    expect(valid.length).toBe(1);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('broken.yaml');
  });

  it('returns empty valid and empty errors for empty input', () => {
    const { valid, errors } = parseSkillDirectory([]);
    expect(valid.length).toBe(0);
    expect(errors.length).toBe(0);
  });

  it('returns only errors when all files are malformed', () => {
    const { valid, errors } = parseSkillDirectory([badFile]);
    expect(valid.length).toBe(0);
    expect(errors.length).toBe(1);
  });

  it('valid results have correct SkillConfig shape', () => {
    const { valid } = parseSkillDirectory([goodFile]);
    expect(valid[0]?.id).toBe('morning-briefing');
    expect(valid[0]?.name).toBe('Morning Briefing');
  });
});
