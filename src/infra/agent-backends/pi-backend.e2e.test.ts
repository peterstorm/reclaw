/**
 * End to end against the real `pi` binary: the arguments piBackend builds put
 * the personality in Pi's system prompt and leave the user's message alone.
 *
 * Why it matters: cortex's Pi extension ranks per-prompt memory recall against
 * `event.prompt` in `before_agent_start`. When reclaw prefixed the personality
 * to the message, recall matched the persona instead of the question. The unit
 * tests pin the argument order; only Pi itself can show where the text lands.
 *
 * A capture extension records the `before_agent_start` event and exits before
 * any model is called, so no network, credentials or tokens are involved.
 * Skipped where `pi` is not installed.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SCHEDULED_PREAMBLE,
  buildChatPrompt,
  buildPrompt,
  personalityInstructions,
  scheduledRunInstructions,
} from '../../core/prompt-builder.js';
import { piBackend } from './pi-backend.js';

const piInstalled = spawnSync('pi', ['--version'], { encoding: 'utf8' }).status === 0;

// Shaped like a real personality.md: markdown, a `---` rule, and lines that
// start with dashes, which must not be read as Pi flags.
const PERSONALITY = `
- You are a personal AI assistant on a homelab.
---
# Style
--model is a word here, not a flag. Quote "this", keep $HOME literal.
`;

type Captured = Readonly<{ prompt: string; systemPrompt: string }>;

/** The capture file is wire data written by another process: parse it. */
function parseCaptured(raw: unknown): Captured {
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'prompt' in raw &&
    'systemPrompt' in raw &&
    typeof raw.prompt === 'string' &&
    typeof raw.systemPrompt === 'string'
  ) {
    return { prompt: raw.prompt, systemPrompt: raw.systemPrompt };
  }
  throw new Error(`unexpected capture: ${JSON.stringify(raw)}`);
}

const INSTRUCTIONS = ((): string => {
  const parsed = personalityInstructions(PERSONALITY);
  if (parsed === undefined) throw new Error('the fixture personality must not be blank');
  return parsed;
})();

let dir: string;
let sessionDir: string;
let capturePath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'reclaw-pi-e2e-'));
  sessionDir = path.join(dir, 'sessions');
  mkdirSync(sessionDir);
  capturePath = path.join(dir, 'captured.json');
  writeFileSync(
    path.join(dir, 'capture.ts'),
    `import { writeFileSync } from 'node:fs';
type AgentStart = { prompt: string; systemPrompt: string };
type Pi = { on: (name: string, handler: (event: AgentStart) => Promise<void>) => void };
export default function (pi: Pi) {
  pi.on('before_agent_start', async (event) => {
    writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ prompt: event.prompt, systemPrompt: event.systemPrompt }));
    process.exit(0);
  });
}
`,
  );
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * Run the args piBackend built, feeding the prompt on stdin as the runner
 * does. Test-only flags keep Pi off the network, off the user's extensions and
 * sessions, and load the capture extension.
 */
function runPi(
  builtArgs: readonly string[],
  prompt: string,
  extra: readonly string[] = [],
): Captured {
  expect(builtArgs[0]).toBe('pi');
  const result = spawnSync(
    'pi',
    [
      ...builtArgs.slice(1),
      '--offline',
      '--session-dir',
      sessionDir,
      ...extra,
      '-ne',
      '-e',
      path.join(dir, 'capture.ts'),
    ],
    { cwd: dir, input: prompt, encoding: 'utf8', timeout: 60_000 },
  );
  expect(result.status, `pi exited ${result.status}: ${result.stderr}`).toBe(0);
  const raw: unknown = JSON.parse(readFileSync(capturePath, 'utf8'));
  return parseCaptured(raw);
}

/** A resumable session: Pi looks a session up by the id in its header line. */
function existingSession(id: string): void {
  writeFileSync(
    path.join(sessionDir, `2026-11-20T21-00-00-000Z_${id}.jsonl`),
    `${JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-11-20T21:00:00.000Z', cwd: dir })}\n`,
  );
}

const addendum = (systemPrompt: string): string | undefined =>
  /<addendum>\n([\s\S]*?)\n<\/addendum>/.exec(systemPrompt)?.[1];

describe.skipIf(!piInstalled)('piBackend against the real pi binary', () => {
  const instructions = INSTRUCTIONS;
  const question = 'which NVMe slot should the second drive go in?';

  it('a fresh chat turn: the personality is the system prompt addendum, the prompt is only the question', () => {
    const args = piBackend.buildArgs({ appendSystemPrompt: instructions, allowedTools: [] });

    const captured = runPi(args, buildChatPrompt(question), ['--no-session']);

    expect(captured.prompt).toBe(question);
    expect(addendum(captured.systemPrompt)).toBe(instructions);
  }, 90_000);

  it('a resumed chat turn: --session and the addendum together, the prompt still only the question', () => {
    const sessionId = '01a1faf1-0000-7000-8000-00000000e2e1';
    existingSession(sessionId);
    const args = piBackend.buildArgs({
      resumeSessionId: sessionId,
      appendSystemPrompt: instructions,
      allowedTools: [],
    });

    const captured = runPi(args, buildChatPrompt(question));

    expect(captured.prompt).toBe(question);
    expect(addendum(captured.systemPrompt)).toBe(instructions);
  }, 90_000);

  it('a scheduled run: personality and run marker in the addendum, the prompt is only the rendered template', () => {
    const template =
      'Today is {{dayOfWeek}}, {{date}}.\n\n{{scheduledPreamble}}\n\nCheck the homelab.';
    const prompt = buildPrompt(template, { date: '2026-11-21', dayOfWeek: 'Saturday' });
    const system = scheduledRunInstructions(PERSONALITY, 'homelab-watchdog');
    const args = piBackend.buildArgs({ appendSystemPrompt: system, allowedTools: [] });

    const captured = runPi(args, prompt, ['--no-session']);

    expect(captured.prompt).toBe(
      `Today is Saturday, 2026-11-21.\n\n${SCHEDULED_PREAMBLE}\n\nCheck the homelab.`,
    );
    expect(addendum(captured.systemPrompt)).toBe(
      `${instructions}\n\nReclaw scheduled skill run: homelab-watchdog`,
    );
  }, 90_000);

  it('without instructions there is no addendum at all', () => {
    const captured = runPi(piBackend.buildArgs({ allowedTools: [] }), question, ['--no-session']);

    expect(captured.prompt).toBe(question);
    expect(addendum(captured.systemPrompt)).toBeUndefined();
  }, 90_000);
});
