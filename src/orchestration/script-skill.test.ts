import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScriptContext, ScriptModule } from '../core/script-skill.js';
import type { SkillId } from '../core/types.js';
import { defaultScriptStateRoot, importScriptModule, runScriptSkill } from './script-skill.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const skillId = 'watcher' as SkillId;

const makeScriptSkill = () => ({
  id: skillId,
  name: 'Watcher',
  schedule: '*/15 * * * *',
  permissionProfile: 'scheduled' as const,
  validityWindowMinutes: 15,
  environment: ['GARMIN_EMAIL'] as const,
  dependsOn: null,
  script: 'watcher.ts',
});

const makeDeps = (
  run: ScriptModule['run'],
  overrides: Partial<Parameters<typeof runScriptSkill>[1]> = {},
) => ({
  skillsDir: '/skills',
  stateRoot: '/state-root',
  env: { GARMIN_EMAIL: 'me@example.com', TELEGRAM_TOKEN: 'must-not-leak' },
  timeoutMs: 5_000,
  now: () => new Date('2026-11-18T12:00:00Z'),
  importModule: vi.fn(async () => ({ run })),
  ...overrides,
});

// ─── runScriptSkill ───────────────────────────────────────────────────────────

describe('runScriptSkill', () => {
  const dirs: string[] = [];
  const makeTempDir = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'reclaw-script-root-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('runs the module with a context scoped to the skill', async () => {
    const stateRoot = await makeTempDir();
    const seen: ScriptContext[] = [];
    const run = async (context: ScriptContext) => {
      seen.push(context);
      await context.stateDir.writeFileAtomic('probe.txt', 'scoped');
      return { kind: 'silent' } as const;
    };
    const deps = makeDeps(run, { stateRoot });

    const result = await runScriptSkill(makeScriptSkill(), deps);

    expect(result).toEqual({ ok: true, value: { kind: 'silent' } });
    expect(deps.importModule).toHaveBeenCalledWith('/skills/watcher.ts');
    const context = seen[0];
    if (context === undefined) throw new Error('the script never ran');
    expect(context.skillId).toBe(skillId);
    expect(context.now()).toEqual(new Date('2026-11-18T12:00:00Z'));
    expect(context.env).toEqual({ GARMIN_EMAIL: 'me@example.com' });
    // The state dir is the skill's own directory under the state root.
    await expect(context.stateDir.readFile('probe.txt')).resolves.toBe('scoped');
  });

  it('returns a message outcome unchanged', async () => {
    const result = await runScriptSkill(
      makeScriptSkill(),
      makeDeps(async () => ({ kind: 'message', text: '#26 done' })),
    );
    expect(result).toEqual({ ok: true, value: { kind: 'message', text: '#26 done' } });
  });

  it('fails with the error message when the script throws', async () => {
    const result = await runScriptSkill(
      makeScriptSkill(),
      makeDeps(async () => {
        throw new Error('state file unreadable');
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: 'script "watcher.ts" failed: state file unreadable',
    });
  });

  it('fails when the module exports no run function (loader contract violation)', async () => {
    const deps = makeDeps(async () => ({ kind: 'silent' }) as const);
    (deps.importModule as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const result = await runScriptSkill(makeScriptSkill(), deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not a function');
  });

  it('fails when the loader itself rejects', async () => {
    const deps = makeDeps(async () => ({ kind: 'silent' }) as const);
    (deps.importModule as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('compile error'));
    const result = await runScriptSkill(makeScriptSkill(), deps);
    expect(result).toEqual({ ok: false, error: 'script "watcher.ts" failed: compile error' });
  });

  it('enforces the skill timeout', async () => {
    const result = await runScriptSkill(
      makeScriptSkill(),
      makeDeps(() => new Promise<never>(() => undefined), { timeoutMs: 20 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('timed out after 20ms');
  });
});

// ─── importScriptModule (integration: real dynamic import) ────────────────────

describe('importScriptModule', () => {
  it('loads a real module file and requires the run export', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'reclaw-script-mod-'));
    try {
      const file = join(dir, 'mod.ts');
      await writeFile(
        file,
        'export const run = async () => ({ kind: "message", text: "hi" });\n',
        'utf8',
      );
      const mod = await importScriptModule(file);
      await expect(mod.run({} as never)).resolves.toEqual({ kind: 'message', text: 'hi' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a module without a run export', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'reclaw-script-mod-'));
    try {
      const file = join(dir, 'broken.ts');
      await writeFile(file, 'export const notRun = 1;\n', 'utf8');
      await expect(importScriptModule(file)).rejects.toThrow('does not export run(context)');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ─── defaultScriptStateRoot ───────────────────────────────────────────────────

describe('defaultScriptStateRoot', () => {
  it('lives under ~/.cache/reclaw next to the legacy watcher state', () => {
    expect(defaultScriptStateRoot()).toMatch(/\.cache\/reclaw\/script-skills$/);
  });
});
