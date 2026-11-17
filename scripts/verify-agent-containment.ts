#!/usr/bin/env bun

/**
 * verify-agent-containment (host smoke check) — proves, on the real host, that a
 * timed-out agent run takes its whole process tree with it.
 *
 * Runs the production runner (`runAgent` → `Bun.spawn` → `systemd-run --scope`)
 * with a stand-in backend whose "agent" is a bash script. That script starts a
 * `setsid` grandchild — the same escape Claude Code's Bash tool performs for
 * every command, and the one that orphaned vitest workers on 2026-11-17 —
 * then hangs. The check passes when:
 *
 *   1. a well-behaved run round-trips stdin → stdout through the scope;
 *   2. the hanging run reports a typed timeout;
 *   3. the detached grandchild is dead afterwards;
 *   4. the run's scope unit is gone.
 *
 * Usage: bun scripts/verify-agent-containment.ts [--slice reclaw-agents.slice]
 * Needs the user systemd bus (XDG_RUNTIME_DIR / DBUS_SESSION_BUS_ADDRESS).
 * Exit 0 = contained, 1 = a check failed.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentContainmentSchema } from '../src/core/agent-containment.js';
import { runAgent } from '../src/infra/agent-backends/runner.js';
import type { AgentBackend } from '../src/infra/agent-backends/types.js';

const sliceArg = process.argv.indexOf('--slice');
const slice = sliceArg === -1 ? 'reclaw-agents.slice' : process.argv[sliceArg + 1];

const containment = agentContainmentSchema.parse({
  kind: 'systemd-scope',
  slice,
  bindsTo: null,
  runtimeMaxSec: 300,
});

const bashBackend = (script: string): AgentBackend => ({
  name: 'verify',
  buildArgs: () => ['bash', '-c', script],
  cleanEnv: (env) => env,
  parseResult: (raw) => ({ text: raw.trim() || null, sessionId: null }),
  extractStreamDelta: () => null,
  extractSessionId: () => null,
});

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const unitsMatching = async (pattern: string): Promise<string> => {
  const proc = Bun.spawn(['systemctl', '--user', 'list-units', '--all', '--no-legend', pattern]);
  return (await new Response(proc.stdout).text()).trim();
};

// The runner logs each contained run's scope unit; capture them so the leftover
// check looks only at this script's runs, never at live agent runs on the host.
const scopeUnits: string[] = [];
const consoleInfo = console.info;
console.info = (...args: unknown[]): void => {
  const unit = String(args[0]).match(/reclaw-agent-[0-9a-f-]{36}\.scope/)?.[0];
  if (unit !== undefined) scopeUnits.push(unit);
  consoleInfo(...args);
};

const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string): void => {
  checks.push({ name, ok, detail });
  console.error(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const workDir = mkdtempSync(join(tmpdir(), 'reclaw-containment-'));
try {
  // 1. Pipes and exit code survive the scope wrapper.
  const echo = await runAgent(bashBackend('read -r line; echo "echo:$line"'), {
    prompt: 'ping\n',
    cwd: workDir,
    allowedTools: [],
    timeoutMs: 30_000,
    containment,
  });
  check(
    'a finished run round-trips stdin → stdout inside its scope',
    echo.ok && echo.output === 'echo:ping',
    echo.ok ? `output=${JSON.stringify(echo.output)}` : JSON.stringify(echo.failure),
  );

  // 2–4. A hanging run with a detached grandchild.
  const pidFile = join(workDir, 'grandchild.pid');
  const hang = await runAgent(bashBackend(`setsid sleep 600 & echo $! > ${pidFile}; sleep 600`), {
    prompt: '',
    cwd: workDir,
    allowedTools: [],
    timeoutMs: 2_000,
    containment,
  });
  check(
    'a hanging run reports a typed timeout',
    !hang.ok && hang.failure.kind === 'timeout',
    hang.ok ? 'run unexpectedly succeeded' : `failure=${hang.failure.kind}`,
  );

  const grandchild = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
  check(
    'the setsid-detached grandchild died with the run',
    Number.isInteger(grandchild) && !isAlive(grandchild),
    `pid=${grandchild}`,
  );

  const hangUnit = scopeUnits[1];
  const leftover = hangUnit === undefined ? '' : await unitsMatching(hangUnit);
  check(
    'the timed-out run’s scope is gone',
    hangUnit !== undefined && leftover === '',
    hangUnit === undefined
      ? 'runner logged no scope unit'
      : `${hangUnit} ${leftover || 'collected'}`,
  );
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.ok).length;
console.error(failed === 0 ? '\ncontained ✓' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
