const DAY_MILLISECONDS = 86_400_000;
const IST_OFFSET_MILLISECONDS = 330 * 60_000;
const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const OFFSET_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function parseCivilDate(value: string): Date {
  const day = new Date(`${value}T00:00:00.000Z`);
  if (
    !CIVIL_DATE.test(value) ||
    !Number.isFinite(day.valueOf()) ||
    day.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`Invalid calendar date: ${value}`);
  }
  return day;
}

export function istDateFromTimestamp(value: string): string {
  if (!OFFSET_TIMESTAMP.test(value)) {
    throw new Error(`Timestamp must specify an ISO 8601 offset: ${value}`);
  }
  parseCivilDate(value.slice(0, 10));
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) {
    throw new Error(`Invalid timestamp: ${value}`);
  }
  return new Date(instant + IST_OFFSET_MILLISECONDS).toISOString().slice(0, 10);
}

export function addCalendarDays(value: string, count: number): string {
  if (!Number.isSafeInteger(count)) {
    throw new Error("Calendar day count must be an integer");
  }
  const day = parseCivilDate(value);
  return new Date(day.valueOf() + count * DAY_MILLISECONDS)
    .toISOString()
    .slice(0, 10);
}

export function isBusinessDay(value: string, holidays: ReadonlySet<string>): boolean {
  const weekday = parseCivilDate(value).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !holidays.has(value);
}

export function addBusinessDays(
  value: string,
  count: number,
  holidays: ReadonlySet<string>,
): string {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Business day count must be a nonnegative integer");
  }
  parseCivilDate(value);

  let day = value;
  let remaining = count;
  while (remaining > 0) {
    day = addCalendarDays(day, 1);
    if (isBusinessDay(day, holidays)) {
      remaining -= 1;
    }
  }
  return day;
}
