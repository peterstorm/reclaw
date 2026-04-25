#!/usr/bin/env bun

/**
 * garmin-reschedule-workout.ts
 *
 * Moves a scheduled workout from one date to another.
 * Finds the workoutScheduleId for the given workoutId on the fromDate,
 * deletes that schedule, and re-schedules the same workoutId to toDate.
 *
 * Usage:
 *   bun scripts/garmin-reschedule-workout.ts <workoutId> <fromDate> <toDate>
 *
 * Dates: YYYY-MM-DD
 * Output: JSON result on stdout
 *
 * Requires: GARMIN_EMAIL and GARMIN_PASSWORD env vars
 */

import { GarminConnect } from "@gooin/garmin-connect";
import { existsSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { join } from "node:path";

async function authenticate(): Promise<GarminConnect> {
  const email = process.env.GARMIN_EMAIL;
  const password = process.env.GARMIN_PASSWORD;
  if (!email || !password) {
    console.error("[FATAL] GARMIN_EMAIL and GARMIN_PASSWORD env vars required");
    process.exit(1);
  }
  const tokenDir = join(process.env.HOME ?? "/home/peterstorm", ".cache", "garmin");
  const client = new GarminConnect({ username: email, password: password });
  if (existsSync(join(tokenDir, "oauth2_token.json"))) {
    try {
      await client.loadTokenByFile(tokenDir);
      await client.getUserProfile();
    } catch {
      await client.login(email, password);
      await client.exportTokenToFile(tokenDir);
      await chmod(join(tokenDir, "oauth1_token.json"), 0o600);
      await chmod(join(tokenDir, "oauth2_token.json"), 0o600);
    }
  } else {
    await client.login(email, password);
    await client.exportTokenToFile(tokenDir);
    await chmod(join(tokenDir, "oauth1_token.json"), 0o600);
    await chmod(join(tokenDir, "oauth2_token.json"), 0o600);
  }
  return client;
}

async function main(): Promise<void> {
  const [workoutIdArg, fromDate, toDate] = process.argv.slice(2);
  if (!workoutIdArg || !fromDate || !toDate) {
    console.error("Usage: bun garmin-reschedule-workout.ts <workoutId> <fromDate> <toDate>");
    process.exit(1);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    console.error("[FATAL] Dates must be YYYY-MM-DD");
    process.exit(1);
  }

  const client = await authenticate();
  const rawClient = (client as unknown as { client: { get: (u: string) => Promise<unknown>; delete: (u: string) => Promise<unknown> } }).client;

  // 1. Find the scheduleId for this workout on fromDate via the calendar
  const [year, month] = fromDate.split("-").map(Number) as [number, number];
  console.error(`[INFO] Fetching calendar for ${year}-${String(month).padStart(2, "0")}...`);
  const calendar = await client.getCalendar(year, month - 1) as { calendarItems?: Array<Record<string, unknown>> };
  const items = calendar.calendarItems ?? [];

  const match = items.find((i) =>
    String(i.workoutId) === String(workoutIdArg) &&
    i.date === fromDate &&
    i.itemType === "workout"
  );

  if (!match) {
    console.error(`[FATAL] No scheduled workout with id ${workoutIdArg} found on ${fromDate}`);
    console.error(`[DEBUG] Calendar items for ${fromDate}:`, JSON.stringify(items.filter(i => i.date === fromDate), null, 2));
    process.exit(1);
  }

  const scheduleId = match.id ?? match.workoutScheduleId;
  if (!scheduleId) {
    console.error(`[FATAL] No schedule id found on calendar item:`, JSON.stringify(match, null, 2));
    process.exit(1);
  }
  console.error(`[INFO] Found schedule id: ${scheduleId}`);

  // 2. Delete the existing schedule
  console.error(`[INFO] Deleting schedule ${scheduleId}...`);
  await rawClient.delete(`https://connectapi.garmin.com/workout-service/schedule/${scheduleId}`);
  console.error(`[INFO] Schedule deleted`);

  // 3. Re-schedule to new date
  console.error(`[INFO] Scheduling workout ${workoutIdArg} for ${toDate}...`);
  const targetDate = new Date(toDate + "T00:00:00");
  const scheduled = await client.scheduleWorkout({ workoutId: String(workoutIdArg) }, targetDate) as { workoutScheduleId?: number };
  console.error(`[INFO] Rescheduled successfully. New schedule id: ${scheduled.workoutScheduleId ?? "(unknown)"}`);

  // Export tokens (they may have refreshed)
  const tokenDir = join(process.env.HOME ?? "/home/peterstorm", ".cache", "garmin");
  await client.exportTokenToFile(tokenDir);
  await chmod(join(tokenDir, "oauth1_token.json"), 0o600);
  await chmod(join(tokenDir, "oauth2_token.json"), 0o600);

  console.log(JSON.stringify({
    success: true,
    workoutId: workoutIdArg,
    title: match.title ?? null,
    from: fromDate,
    to: toDate,
    oldScheduleId: scheduleId,
    newScheduleId: scheduled.workoutScheduleId ?? null,
  }, null, 2));
}

main().catch((err) => {
  console.error(`[FATAL] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
