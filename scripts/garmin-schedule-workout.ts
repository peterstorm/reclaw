#!/usr/bin/env bun

/**
 * garmin-schedule-workout.ts
 *
 * Creates a structured workout on Garmin Connect and schedules it to a calendar date.
 *
 * Usage:
 *   echo '<workout_json>' | bun scripts/garmin-schedule-workout.ts YYYY-MM-DD
 *
 * Input:  Workout JSON on stdin (IWorkoutDetail shape)
 * Args:   Target date as YYYY-MM-DD
 * Output: JSON with workoutId and schedule confirmation on stdout
 *
 * Requires: GARMIN_EMAIL and GARMIN_PASSWORD env vars
 */

import type { GarminWorkoutUploadPayload } from '@gooin/garmin-connect';
import { type Result, err, ok } from '../src/core/types.js';
import { connectGarmin, exportGarminTokens, requireGarminCredentials } from './garmin-session.js';

// --- Input ---

async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value, { stream: true }));
  }
  return chunks.join('');
}

/**
 * The stdin workout, forwarded to Garmin verbatim: only workoutName and
 * workoutSegments are checked here, and Garmin's API is the validator of record
 * for the rest. That trust is this function's one cast; callers get the upload
 * payload type.
 */
function parseWorkout(stdinText: string): Result<GarminWorkoutUploadPayload, string> {
  if (!stdinText.trim()) return err('No workout JSON provided on stdin');
  let raw: unknown;
  try {
    raw = JSON.parse(stdinText);
  } catch (e) {
    return err(`Invalid JSON on stdin: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'workoutName' in raw &&
    raw.workoutName &&
    'workoutSegments' in raw &&
    raw.workoutSegments
  ) {
    return ok(raw as GarminWorkoutUploadPayload);
  }
  return err('Workout JSON must include workoutName and workoutSegments');
}

// --- Main ---

async function main(): Promise<void> {
  const dateArg = process.argv[2];
  if (!dateArg || !/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
    console.error("Usage: echo '<workout_json>' | bun garmin-schedule-workout.ts YYYY-MM-DD");
    process.exit(1);
  }

  const parsed = parseWorkout(await readStdin());
  if (!parsed.ok) {
    console.error(`[FATAL] ${parsed.error}`);
    process.exit(1);
  }
  const workout = parsed.value;

  const client = await connectGarmin(requireGarminCredentials(), {
    narrate: (line) => console.error(line),
  });

  // Create the workout
  console.error(`[INFO] Creating workout: ${workout.workoutName}...`);
  const created = await client.addWorkout(workout);
  const workoutId = created.workoutId;
  console.error(`[INFO] Workout created with ID: ${workoutId}`);

  // Schedule it to the target date
  const targetDate = new Date(`${dateArg}T00:00:00`);
  console.error(`[INFO] Scheduling workout ${workoutId} for ${dateArg}...`);
  const scheduled = await client.scheduleWorkout({ workoutId: String(workoutId) }, targetDate);
  console.error('[INFO] Workout scheduled successfully');

  // Export tokens (they may have refreshed)
  await exportGarminTokens(client);

  // Output result to stdout
  const result = {
    success: true,
    workoutId,
    workoutName: workout.workoutName,
    scheduledDate: dateArg,
    scheduleId: scheduled.workoutScheduleId ?? null,
  };
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(`[FATAL] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
