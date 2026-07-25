/** A single clock seam for summaries and notification scheduling. */
let clock: () => number = () => Date.now();

export function now(): number {
  return clock();
}

/** Test hook. Production code must use `now()` rather than reading the clock directly. */
export function setClockForTests(next?: () => number): void {
  clock = next ?? (() => Date.now());
}

/** Next occurrence of a wall-clock time in an IANA timezone. */
export function nextScheduledTime(time: string, timezone: string, from = now()): number {
  const match = /^(?:[01]\d|2[0-3]):[0-5]\d$/.exec(time);
  const [hour, minute] = (match ? time : "08:00").split(":").map(Number);
  let zone = timezone;
  try { new Intl.DateTimeFormat("en-CA", { timeZone: zone }); } catch { zone = "UTC"; }
  const parts = dateParts(from, zone, false);
  let target = Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute);
  let candidate = target - zoneOffset(target, zone);
  if (candidate <= from) {
    target += 86_400_000;
    candidate = target - zoneOffset(target, zone);
  }
  return candidate;
}

function zoneOffset(at: number, timezone: string): number {
  const parts = dateParts(at, timezone, true);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour ?? 0, parts.minute ?? 0) - at;
}

function dateParts(at: number, timezone: string, time: boolean): Record<string, number> {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    ...(time ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" as const } : {}),
  }).formatToParts(new Date(at)).reduce<Record<string, number>>((out, part) => {
    if (part.type !== "literal") out[part.type] = Number(part.value);
    return out;
  }, {});
}
