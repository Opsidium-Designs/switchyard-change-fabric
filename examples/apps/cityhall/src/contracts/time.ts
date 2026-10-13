// cityhall SHARED time contract.
//
// The city keeps its calendar in America/Chicago. A calendar date is a
// "YYYY-MM-DD" string; an instant is an ISO 8601 timestamp with an offset.
// Deadlines the city promises (inspections, records responses, appeal windows,
// repair orders, waitlist offers, event filings) are counted in BUSINESS days:
// weekdays that are not city holidays.
//
//   cityDate(instant)          the calendar date of an instant in the city
//   addDays(date, n)           a calendar date n days later (n may be negative)
//   addMonths(date, n)         n months later, clamped to the month's last day
//   daysBetween(a, b)          whole days from a to b
//   daysInMonth("YYYY-MM")     28 to 31
//   isBusinessDay(date)        a weekday that is not a city holiday
//   addBusinessDays(date, n)   the deadline n business days from date

/** The city's time zone. */
export const CITY_TIME_ZONE = "America/Chicago";

/** City holidays (observed dates). */
export const CITY_HOLIDAYS: readonly string[] = [
  "2026-01-01",
  "2026-01-19",
  "2026-02-16",
  "2026-05-25",
  "2026-06-19",
  "2026-07-03",
  "2026-09-07",
  "2026-11-11",
  "2026-11-26",
  "2026-11-27",
  "2026-12-25",
  "2027-01-01",
];

const DAY_MS = 86_400_000;

function toUtc(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The calendar date of an instant in the city's time zone. */
export function cityDate(instant: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CITY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** A calendar date n days later (or earlier for a negative n). */
export function addDays(date: string, n: number): string {
  return fromUtc(toUtc(date) + n * DAY_MS);
}

/** The number of days in a "YYYY-MM" month. */
export function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 0)).getUTCDate();
}

/** n months later; a day past the target month's end clamps to its last day. */
export function addMonths(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const index = y! * 12 + (m! - 1) + n;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const mm = String(month).padStart(2, "0");
  const day = Math.min(d!, daysInMonth(`${year}-${mm}`));
  return `${year}-${mm}-${String(day).padStart(2, "0")}`;
}

/** Whole days from a to b (positive when b is later). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtc(b) - toUtc(a)) / DAY_MS);
}

/** 0 (Sunday) to 6 (Saturday). */
export function weekday(date: string): number {
  return new Date(toUtc(date)).getUTCDay();
}

/** A weekday that is not a city holiday. */
export function isBusinessDay(date: string): boolean {
  const day = weekday(date);
  return day >= 1 && day <= 5 && !CITY_HOLIDAYS.includes(date);
}

/** The deadline n business days from `date`. */
export function addBusinessDays(date: string, n: number): string {
  let current = date;
  let counted = 0;
  for (;;) {
    const day = weekday(current);
    if (day >= 1 && day <= 5) {
      counted += 1;
      if (counted >= n) {
        return current;
      }
    }
    current = addDays(current, 1);
  }
}
