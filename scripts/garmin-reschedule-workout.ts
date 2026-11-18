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

import type { GarminConnect } from '@gooin/garmin-connect';
import { connectGarmin, exportGarminTokens } from './garmin-session.js';

type Schedule = { readonly item: Record<string, unknown>; readonly scheduleId: unknown };

/** The calendar item scheduling `workoutId` on `fromDate`; exits when there is none. */
async function findSchedule(
  client: GarminConnect,
  workoutIdArg: string,
  fromDate: string,
): Promise<Schedule> {
  const [year, month] = fromDate.split('-').map(Number) as [number, number];
  console.error(`[INFO] Fetching calendar for ${year}-${String(month).padStart(2, '0')}...`);
  const calendar = (await client.getCalendar(year, month - 1)) as {
    calendarItems?: Array<Record<string, unknown>>;
  };
  const items = calendar.calendarItems ?? [];

  const match = items.find(
    (i) =>
      String(i.workoutId) === String(workoutIdArg) &&
      i.date === fromDate &&
      i.itemType === 'workout',
  );

  if (!match) {
    console.error(`[FATAL] No scheduled workout with id ${workoutIdArg} found on ${fromDate}`);
    console.error(
      `[DEBUG] Calendar items for ${fromDate}:`,
      JSON.stringify(
        items.filter((i) => i.date === fromDate),
        null,
        2,
      ),
    );
    process.exit(1);
  }

  const scheduleId = match.id ?? match.workoutScheduleId;
  if (!scheduleId) {
    console.error('[FATAL] No schedule id found on calendar item:', JSON.stringify(match, null, 2));
    process.exit(1);
  }
  console.error(`[INFO] Found schedule id: ${scheduleId}`);
  return { item: match, scheduleId };
}

/** Delete the old schedule, then schedule the same workout on `toDate`; returns the new schedule id. */
async function moveSchedule(
  client: GarminConnect,
  scheduleId: unknown,
  workoutIdArg: string,
  toDate: string,
): Promise<number | undefined> {
  const rawClient = (
    client as unknown as {
      client: { get: (u: string) => Promise<unknown>; delete: (u: string) => Promise<unknown> };
    }
  ).client;

  console.error(`[INFO] Deleting schedule ${scheduleId}...`);
  await rawClient.delete(`https://connectapi.garmin.com/workout-service/schedule/${scheduleId}`);
  console.error('[INFO] Schedule deleted');

  console.error(`[INFO] Scheduling workout ${workoutIdArg} for ${toDate}...`);
  const targetDate = new Date(`${toDate}T00:00:00`);
  const scheduled = (await client.scheduleWorkout(
    { workoutId: String(workoutIdArg) },
    targetDate,
  )) as { workoutScheduleId?: number };
  console.error(
    `[INFO] Rescheduled successfully. New schedule id: ${scheduled.workoutScheduleId ?? '(unknown)'}`,
  );
  return scheduled.workoutScheduleId;
}

async function main(): Promise<void> {
  const [workoutIdArg, fromDate, toDate] = process.argv.slice(2);
  if (!workoutIdArg || !fromDate || !toDate) {
    console.error('Usage: bun garmin-reschedule-workout.ts <workoutId> <fromDate> <toDate>');
    process.exit(1);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    console.error('[FATAL] Dates must be YYYY-MM-DD');
    process.exit(1);
  }

  const client = await connectGarmin(() => {});
  // 1. Find the scheduleId for this workout on fromDate via the calendar
  const { item: match, scheduleId } = await findSchedule(client, workoutIdArg, fromDate);
  // 2. Delete the existing schedule, 3. re-schedule to the new date
  const newScheduleId = await moveSchedule(client, scheduleId, workoutIdArg, toDate);

  // Export tokens (they may have refreshed)
  await exportGarminTokens(client);

  console.log(
    JSON.stringify(
      {
        success: true,
        workoutId: workoutIdArg,
        title: match.title ?? null,
        from: fromDate,
        to: toDate,
        oldScheduleId: scheduleId,
        newScheduleId: newScheduleId ?? null,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(`[FATAL] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
