import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSkillConfig } from '../core/skill-config.js';

// The real skill files, parsed as the runtime parses them. A scheduled skill that runs on the
// Pi backend and declares no fallback fails the whole job when the desktop vLLM box is off
// (EHOSTUNREACH), instead of rerunning once on Claude. The three learn skills did exactly that
// on 2026-11-26 until they were given one.

const SKILLS_DIR = join(import.meta.dirname, '../../workspace/skills');

const scheduledPromptSkills = readdirSync(SKILLS_DIR)
  .filter((file) => file.endsWith('.yaml'))
  .flatMap((file) => {
    const parsed = parseSkillConfig(readFileSync(join(SKILLS_DIR, file), 'utf8'), file);
    if (!parsed.ok) throw new Error(`${file}: ${parsed.error}`);
    const skill = parsed.value;
    return skill.schedule !== null && 'promptTemplate' in skill ? [{ file, skill }] : [];
  });

describe('the workspace skills', () => {
  it('finds the scheduled prompt skills it is meant to check', () => {
    const files = scheduledPromptSkills.map((s) => s.file);
    expect(files).toEqual(
      expect.arrayContaining(['learn-lesson.yaml', 'learn-recall.yaml', 'learn-feynman.yaml']),
    );
  });

  it.each(scheduledPromptSkills.map(({ file, skill }) => [file, skill] as const))(
    '%s reruns on Claude when its primary backend cannot serve',
    (_file, skill) => {
      expect(skill.fallback).toMatchObject({ backend: 'claude' });
    },
  );
});
