#!/usr/bin/env bun

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// --- Types ---

type CalendarEvent = {
  readonly date: string;
  readonly startTime: string | null;
  readonly endTime: string | null;
  readonly title: string;
  readonly location: string | null;
  readonly isAllDay: boolean;
};

// --- Constants ---

const CALENDAR_DIR =
  join(
    process.env.HOME ?? "/home/peterstorm",
    ".local/share/calendars/icloud/D8C2180E-3AD0-406E-9B55-23DA5F2CC674",
  );

// --- Parsing ---

const unfoldIcs = (raw: string): string =>
  raw.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");

const extractVevents = (ics: string): string[] => {
  const events: string[] = [];
  const unfolded = unfoldIcs(ics);
  let idx = 0;
  while (true) {
    const start = unfolded.indexOf("BEGIN:VEVENT", idx);
    if (start === -1) break;
    const end = unfolded.indexOf("END:VEVENT", start);
    if (end === -1) break;
    events.push(unfolded.slice(start, end + "END:VEVENT".length));
    idx = end + "END:VEVENT".length;
  }
  return events;
};

const getProperty = (vevent: string, prop: string): string | null => {
  // Match property with optional params: DTSTART;TZID=...:value or DTSTART:value
  const regex = new RegExp(`^${prop}[;:](.*)$`, "m");
  const match = vevent.match(regex);
  if (!match) return null;
  // Return the value after the last colon in the match (handles params like TZID=...)
  const full = match[1];
  const colonIdx = full.indexOf(":");
  // If there are params (e.g. TZID=Europe/Copenhagen:20260303T130000), split at ":"
  // If no params (e.g. just 20260303T130000), the full string is the value
  return colonIdx !== -1 ? full.slice(colonIdx + 1) : full;
};

const parseDtValue = (
  raw: string,
): { date: string; time: string | null; isAllDay: boolean } => {
  // All-day: 20260303
  if (raw.length === 8) {
    const date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    return { date, time: null, isAllDay: true };
  }
  // Timed: 20260303T130000 or 20260303T130000Z
  const dateStr = raw.slice(0, 8);
  const timeStr = raw.slice(9, 15);
  const date = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
  const time = `${timeStr.slice(0, 2)}:${timeStr.slice(2, 4)}`;
  return { date, time, isAllDay: false };
};

const parseVevent = (vevent: string): CalendarEvent | null => {
  const dtstart = getProperty(vevent, "DTSTART");
  if (!dtstart) return null;

  const dtend = getProperty(vevent, "DTEND");
  const summary = getProperty(vevent, "SUMMARY");
  const location = getProperty(vevent, "LOCATION");

  const start = parseDtValue(dtstart);
  const end = dtend ? parseDtValue(dtend) : null;

  return {
    date: start.date,
    startTime: start.time,
    endTime: end?.time ?? null,
    title: summary ?? "(No title)",
    location: location && location.trim() !== "" ? location.trim().replace(/\\,/g, ",").replace(/\\;/g, ";") : null,
    isAllDay: start.isAllDay,
  };
};

// --- Date range helpers ---

const parseDate = (s: string): Date => new Date(s + "T00:00:00");

const formatDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const dateRange = (from: string, to: string): string[] => {
  const dates: string[] = [];
  const start = parseDate(from);
  const end = parseDate(to);
  const current = new Date(start);
  while (current <= end) {
    dates.push(formatDate(current));
    current.setDate(current.getDate() + 1);
  }
  return dates;
};

const isInRange = (eventDate: string, dates: Set<string>, allDayEndDate?: string): boolean => {
  if (dates.has(eventDate)) return true;
  // Multi-day all-day events span from DTSTART to DTEND (exclusive)
  if (allDayEndDate && allDayEndDate > eventDate) {
    const span = dateRange(eventDate, allDayEndDate);
    // DTEND is exclusive for all-day events, so remove last day
    span.pop();
    return span.some((d) => dates.has(d));
  }
  return false;
};

// --- Main ---

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help")) {
    console.error("Usage: calendar-events.ts <date> [end-date]");
    console.error("  <date>       Single date (YYYY-MM-DD) or start of range");
    console.error("  [end-date]   Optional end of range (inclusive)");
    console.error("");
    console.error("Examples:");
    console.error("  calendar-events.ts 2026-03-22          # single day");
    console.error("  calendar-events.ts 2026-03-16 2026-03-22  # week range");
    process.exit(args.includes("--help") ? 0 : 1);
  }

  const fromDate = args[0];
  const toDate = args[1] ?? fromDate;
  const targetDates = new Set(dateRange(fromDate, toDate));

  let files: string[];
  try {
    files = (await readdir(CALENDAR_DIR)).filter((f) => f.endsWith(".ics"));
  } catch (e) {
    console.error(`[ERROR] Cannot read calendar directory: ${CALENDAR_DIR}`);
    console.log("[]");
    process.exit(0);
  }

  const events: CalendarEvent[] = [];

  for (const file of files) {
    try {
      const content = await readFile(join(CALENDAR_DIR, file), "utf-8");
      const vevents = extractVevents(content);

      for (const vevent of vevents) {
        const event = parseVevent(vevent);
        if (!event) continue;

        // For multi-day all-day events, get the end date
        const dtend = getProperty(vevent, "DTEND");
        const endParsed = dtend ? parseDtValue(dtend) : null;
        const allDayEndDate = event.isAllDay && endParsed ? endParsed.date : undefined;

        if (isInRange(event.date, targetDates, allDayEndDate)) {
          // For multi-day events in range, emit one entry per day in range
          if (event.isAllDay && allDayEndDate && allDayEndDate > event.date) {
            const span = dateRange(event.date, allDayEndDate);
            span.pop(); // DTEND exclusive
            for (const d of span) {
              if (targetDates.has(d)) {
                events.push({ ...event, date: d });
              }
            }
          } else {
            events.push(event);
          }
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  // Sort by date, then all-day first, then by start time
  events.sort((a, b) => {
    const dateCmp = a.date.localeCompare(b.date);
    if (dateCmp !== 0) return dateCmp;
    if (a.isAllDay && !b.isAllDay) return -1;
    if (!a.isAllDay && b.isAllDay) return 1;
    return (a.startTime ?? "").localeCompare(b.startTime ?? "");
  });

  console.log(JSON.stringify(events, null, 2));
}

main().catch((e) => {
  console.error(`[FATAL] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
