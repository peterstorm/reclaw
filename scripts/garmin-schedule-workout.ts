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

import { GarminConnect } from "@gooin/garmin-connect";
import { existsSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { join } from "node:path";

// --- Auth (same pattern as garmin-fetch.ts) ---

async function authenticate(): Promise<GarminConnect> {
  const email = process.env.GARMIN_EMAIL;
  const password = process.env.GARMIN_PASSWORD;

  if (!email || !password) {
    console.error("[FATAL] GARMIN_EMAIL and GARMIN_PASSWORD env vars required");
    process.exit(1);
  }

  const tokenDir = join(process.env.HOME ?? "/home/peterstorm", ".cache", "garmin");
  const client = new GarminConnect({ username: email, password: password });

  const hasTokens = existsSync(join(tokenDir, "oauth2_token.json"));
  if (hasTokens) {
    console.error("[INFO] Loading cached tokens...");
    try {
      await client.loadTokenByFile(tokenDir);
      await client.getUserProfile();
      console.error("[INFO] Cached tokens valid");
    } catch {
      console.error("[INFO] Cached tokens expired, logging in fresh...");
      await client.login(email, password);
      await client.exportTokenToFile(tokenDir);
      await chmod(join(tokenDir, "oauth1_token.json"), 0o600);
      await chmod(join(tokenDir, "oauth2_token.json"), 0o600);
      console.error("[INFO] Login successful, tokens cached");
    }
  } else {
    console.error("[INFO] No cached tokens, logging in...");
    await client.login(email, password);
    await client.exportTokenToFile(tokenDir);
    await chmod(join(tokenDir, "oauth1_token.json"), 0o600);
    await chmod(join(tokenDir, "oauth2_token.json"), 0o600);
    console.error("[INFO] Login successful, tokens cached");
  }

  return client;
}

// --- Main ---

async function main(): Promise<void> {
  const dateArg = process.argv[2];
  if (!dateArg || !/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
    console.error("Usage: echo '<workout_json>' | bun garmin-schedule-workout.ts YYYY-MM-DD");
    process.exit(1);
  }

  // Read workout JSON from stdin
  const chunks: string[] = [];
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value, { stream: true }));
  }
  const stdinText = chunks.join("");

  if (!stdinText.trim()) {
    console.error("[FATAL] No workout JSON provided on stdin");
    process.exit(1);
  }

  let workout: Record<string, unknown>;
  try {
    workout = JSON.parse(stdinText);
  } catch (e) {
    console.error(`[FATAL] Invalid JSON on stdin: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  if (!workout.workoutName || !workout.workoutSegments) {
    console.error("[FATAL] Workout JSON must include workoutName and workoutSegments");
    process.exit(1);
  }

  const client = await authenticate();

  // Create the workout
  console.error(`[INFO] Creating workout: ${workout.workoutName}...`);
  const created = await client.addWorkout(workout as any) as any;
  const workoutId = created.workoutId;
  console.error(`[INFO] Workout created with ID: ${workoutId}`);

  // Schedule it to the target date
  const targetDate = new Date(dateArg + "T00:00:00");
  console.error(`[INFO] Scheduling workout ${workoutId} for ${dateArg}...`);
  const scheduled = await client.scheduleWorkout({ workoutId: String(workoutId) }, targetDate) as any;
  console.error(`[INFO] Workout scheduled successfully`);

  // Export tokens (they may have refreshed)
  const tokenDir = join(process.env.HOME ?? "/home/peterstorm", ".cache", "garmin");
  await client.exportTokenToFile(tokenDir);
  await chmod(join(tokenDir, "oauth1_token.json"), 0o600);
  await chmod(join(tokenDir, "oauth2_token.json"), 0o600);

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
