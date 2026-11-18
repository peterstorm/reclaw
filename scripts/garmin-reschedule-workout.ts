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
import { z } from 'zod';
import { connectGarmin, exportGarminTokens, requireGarminCredentials } from './garmin-session.js';

/** Garmin's id for one scheduling of a workout: the calendar item's `id`, or its `workoutScheduleId`. */
type ScheduleId = string | number;

/** The scheduling being moved: its id and the calendar item's title (as Garmin sent it, or null). */
type Schedule = { readonly title: unknown; readonly scheduleId: ScheduleId };

/**
 * The month's calendar as Garmin sends it. The SDK's ICalendarItem omits fields
 * this script reads (workoutScheduleId), so each item stays an untyped record
 * and is read field by field.
 */
const calendarSchema = z.object({ calendarItems: z.array(z.record(z.unknown())).optional() });

/** A present, non-empty id; null for anything else. */
const parseScheduleId = (value: unknown): ScheduleId | null =>
  (typeof value === 'number' || typeof value === 'string') && value ? value : null;

/** The calendar item scheduling `workoutId` on `fromDate`; exits when there is none. */
async function findSchedule(
  client: GarminConnect,
  workoutIdArg: string,
  fromDate: string,
): Promise<Schedule> {
  const [year, month] = fromDate.split('-').map(Number) as [number, number];
  console.error(`[INFO] Fetching calendar for ${year}-${String(month).padStart(2, '0')}...`);
  const raw: unknown = await client.getCalendar(year, month - 1);
  const calendar = calendarSchema.safeParse(raw);
  if (!calendar.success) {
    console.error(`[FATAL] Unexpected calendar payload: ${calendar.error.message}`);
    process.exit(1);
  }
  const items = calendar.data.calendarItems ?? [];

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

  const scheduleId = parseScheduleId(match.id ?? match.workoutScheduleId);
  if (scheduleId === null) {
    console.error('[FATAL] No schedule id found on calendar item:', JSON.stringify(match, null, 2));
    process.exit(1);
  }
  console.error(`[INFO] Found schedule id: ${scheduleId}`);
  return { title: match.title ?? null, scheduleId };
}

/** Delete the old schedule, then schedule the same workout on `toDate`; returns the new schedule id. */
async function moveSchedule(
  client: GarminConnect,
  scheduleId: ScheduleId,
  workoutIdArg: string,
  toDate: string,
): Promise<number | undefined> {
  console.error(`[INFO] Deleting schedule ${scheduleId}...`);
  // The SDK's own unschedule call, so deleting a schedule needs no cast to reach the
  // client's private HTTP transport.
  await client.unscheduleWorkout(scheduleId);
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

  const client = await connectGarmin(requireGarminCredentials(), { narrate: () => {} });
  // 1. Find the scheduleId for this workout on fromDate via the calendar
  const { title, scheduleId } = await findSchedule(client, workoutIdArg, fromDate);
  // 2. Delete the existing schedule, 3. re-schedule to the new date
  const newScheduleId = await moveSchedule(client, scheduleId, workoutIdArg, toDate);

  // Export tokens (they may have refreshed)
  await exportGarminTokens(client);

  console.log(
    JSON.stringify(
      {
        success: true,
        workoutId: workoutIdArg,
        title,
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
