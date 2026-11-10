// ─── Whisper transcriber (subprocess adapter) ─────────────────────────────────
//
// Runs scripts/ig-transcribe.py (faster-whisper, CPU, int8) in a Python that nix provides on
// demand — nothing is installed system-wide. The interpreter is resolved once per process via
// `nix-shell`, then invoked directly so each reel only pays model-load time, not nix eval.

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { InstagramIngestPorts } from '../core/instagram-ingest.js';
import { parseTranscript } from '../core/instagram-transcript.js';
import { err } from '../core/types.js';

const run = promisify(execFile);

const NIX_PYTHON_EXPR = 'python3.withPackages (ps: [ps.faster-whisper])';
const SCRIPT = fileURLToPath(new URL('../../scripts/ig-transcribe.py', import.meta.url));

/** Generous: a 3-minute reel on a cold model download (first run) can take minutes. */
const TRANSCRIBE_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

const resolveNixPython = async (): Promise<string> => {
  const { stdout } = await run(
    'nix-shell',
    ['-p', NIX_PYTHON_EXPR, '--run', 'command -v python3'],
    {
      timeout: 10 * 60 * 1000,
    },
  );
  const python = stdout.trim().split('\n').pop() ?? '';
  if (python.length === 0) throw new Error('nix-shell did not report a python3 path');
  return python;
};

export function createWhisperTranscriber(): InstagramIngestPorts['transcribe'] {
  let python: Promise<string> | null = null;
  const interpreter = (): Promise<string> => {
    // Cache only success: a transient nix failure must not poison the rest of the run.
    python ??= resolveNixPython().catch((e) => {
      python = null;
      throw e;
    });
    return python;
  };

  return async (mediaPath, model) => {
    try {
      const { stdout } = await run(await interpreter(), [SCRIPT, mediaPath, model], {
        timeout: TRANSCRIBE_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
      });
      return parseTranscript(JSON.parse(stdout));
    } catch (e) {
      const stderr = (e as { stderr?: string }).stderr?.trim().split('\n').slice(-3).join(' | ');
      return err(`Whisper failed: ${stderr || (e instanceof Error ? e.message : String(e))}`);
    }
  };
}
