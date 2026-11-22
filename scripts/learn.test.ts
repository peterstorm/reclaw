// The command surface itself: argv parsing, the stdin gate for `--answer -`, the exit code
// a refusal must produce, and the text/JSON split. These are the parts a skill depends on
// and no core test can pin, because they live in the script, not in the orchestrator.

import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { notePath, renderNote, renderRegistry } from '../src/core/__fixtures__/learning.js';
import { REGISTRY_PATH, STUDY_LOG_PATH } from '../src/core/curriculum.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const hasBun = spawnSync('bun', ['--version']).status === 0;
const roots: string[] = [];

const registry = renderRegistry([{ slug: 'a' }]);
const note = renderNote({ slug: 'a', lessons: 2 });

async function makeVault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'learn-script-'));
  roots.push(root);
  for (const [path, content] of [
    [REGISTRY_PATH, registry],
    [notePath('a'), note],
  ] as const) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

type Run = Readonly<{
  child: ReturnType<typeof spawn>;
  exited: Promise<number>;
  stdout: () => string;
  stderr: () => string;
}>;

/** Spawn the real script. `stdin: 'open'` leaves the pipe open and never ends it. */
function learn(vaultRoot: string, args: readonly string[], stdin?: string | 'open'): Run {
  const child = spawn('bun', ['scripts/learn.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env, RECLAW_VAULT_ROOT: vaultRoot },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout?.on('data', (d: Buffer) => {
    out += String(d);
  });
  child.stderr?.on('data', (d: Buffer) => {
    err += String(d);
  });
  if (stdin !== 'open') child.stdin?.end(stdin ?? '');

  const exited = new Promise<number>((resolve) => {
    child.on('close', (code) => resolve(code ?? -1));
  });
  return { child, exited, stdout: () => out, stderr: () => err };
}

const exitWithin = async (run: Run, ms: number): Promise<number | 'timeout'> =>
  Promise.race([
    run.exited,
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms)),
  ]);

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(!hasBun)('scripts/learn.ts', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await makeVault();
  });

  it('prints the rendered lesson message, not JSON, for --message', async () => {
    const run = learn(vaultRoot, ['lesson', '--message']);
    expect(await run.exited).toBe(0);
    expect(run.stdout()).toContain("📖 **Today's lesson** — Note a, lesson 1/2");
    expect(run.stderr()).toBe('');
  });

  it('prints JSON for a data command', async () => {
    const run = learn(vaultRoot, ['lesson']);
    expect(await run.exited).toBe(0);
    expect(JSON.parse(run.stdout())).toMatchObject({ kind: 'lesson', topic: 'a', lesson: 1 });
  });

  it('reads a graded answer from stdin when --answer is -', async () => {
    const read = learn(vaultRoot, ['read', 'a', '1']);
    expect(await read.exited).toBe(0);

    const asked = learn(vaultRoot, ['round', '--size', '1']);
    expect(await asked.exited).toBe(0);
    const { round, cards } = JSON.parse(asked.stdout()) as {
      round: string;
      cards: { id: string }[];
    };
    const card = cards[0]?.id ?? '';

    const free = 'It depends — `$HOME`, "quotes" and\nnewlines stay literal.';
    const graded = learn(vaultRoot, ['grade', round, card, 'good', '--answer', '-'], free);
    expect(await graded.exited).toBe(0);
    expect(JSON.parse(graded.stdout())).toMatchObject({ kind: 'graded', card });

    const log = await readFile(join(vaultRoot, STUDY_LOG_PATH), 'utf8');
    expect(log).toContain(JSON.stringify(free));
  });

  // Regression: the stdin read used to run before the command was parsed, so any command
  // with a stray `--answer -` blocked on an open pipe until the caller closed it.
  it('never reads stdin for a command that does not grade', async () => {
    const run = learn(vaultRoot, ['lesson', '--answer', '-'], 'open');
    const exit = await exitWithin(run, 10_000);
    if (exit === 'timeout') run.child.kill('SIGKILL');
    expect(exit).toBe(0);
    expect(run.stdout()).toContain('"kind": "lesson"');
  });

  it('exits 1 with the reason on stderr when a command is refused, and writes nothing', async () => {
    const run = learn(vaultRoot, ['grade', 'r-unknown', 'a/c01', 'good']);
    expect(await run.exited).toBe(1);
    expect(run.stdout()).toBe('');
    expect(run.stderr()).toContain('unknown round');
    await expect(readFile(join(vaultRoot, STUDY_LOG_PATH), 'utf8')).rejects.toThrow();
  });

  it('prints the usage list and exits 1 for an unknown command', async () => {
    const run = learn(vaultRoot, ['bogus']);
    expect(await run.exited).toBe(1);
    expect(run.stderr()).toContain('usage: learn <command>');
  });
});
