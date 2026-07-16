import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSkillQualityRecorder } from './skill-quality.js';
import type { SkillQualitySignal } from '../core/skill-quality.js';
import type { SkillId } from '../core/types.js';

const baseSignal = (overrides: Partial<SkillQualitySignal> = {}): SkillQualitySignal => ({
  skillId: 'morning-briefing' as SkillId,
  status: 'claude_error',
  durationMs: 1234,
  outputLength: 0,
  errorMessage: 'boom',
  timestamp: '2026-07-16T07:00:12.000Z',
  ...overrides,
});

/**
 * The recorder is fire-and-forget (returns void, appends on a detached
 * microtask), so poll the file until it reaches the expected line count.
 */
async function readLinesWhenReady(path: string, expectedLines: number, timeoutMs = 2000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
      if (lines.length >= expectedLines) return lines;
    } catch {
      // file not created yet
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${expectedLines} line(s) in ${path}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function fileMissing(path: string): Promise<boolean> {
  try {
    await readFile(path, 'utf8');
    return false;
  } catch {
    return true;
  }
}

describe('createSkillQualityRecorder', () => {
  let dir: string;
  let logPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'skill-quality-'));
    // Nested path so the recorder must create the parent dir itself.
    logPath = join(dir, 'nested', 'skill-quality.jsonl');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('appends one JSONL line for an anomalous signal, creating the parent dir', async () => {
    const record = createSkillQualityRecorder(logPath);
    record(baseSignal({ status: 'claude_error', errorMessage: 'subprocess timed out' }));

    const lines = await readLinesWhenReady(logPath, 1);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? '');
    expect(parsed.skillId).toBe('morning-briefing');
    expect(parsed.status).toBe('claude_error');
    expect(parsed.severity).toBe(7);
    expect(parsed.summary).toContain('subprocess timed out');
  });

  it('appends one line per signal, newline-framed', async () => {
    const record = createSkillQualityRecorder(logPath);
    record(baseSignal({ status: 'suppressed', errorMessage: null }));
    record(baseSignal({ status: 'skill_not_found' }));

    const lines = await readLinesWhenReady(logPath, 2);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('drops non-anomalous signals without touching the disk', async () => {
    const record = createSkillQualityRecorder(logPath);
    record(baseSignal({ status: 'success' }));
    record(baseSignal({ status: 'validity_expired' }));

    // Give any (erroneous) async write a chance to land, then assert nothing was written.
    await new Promise((r) => setTimeout(r, 50));
    expect(await fileMissing(logPath)).toBe(true);
  });

  it('never throws to the caller even when the write path is invalid', async () => {
    // A path whose parent is an existing file makes mkdir/appendFile reject;
    // the recorder must swallow it (quality tracking must never fail a job).
    const record = createSkillQualityRecorder(logPath);
    record(baseSignal({ status: 'suppressed', errorMessage: null }));
    await readLinesWhenReady(logPath, 1);

    const badRecorder = createSkillQualityRecorder(join(logPath, 'child.jsonl'));
    expect(() => badRecorder(baseSignal({ status: 'claude_error' }))).not.toThrow();
  });
});
