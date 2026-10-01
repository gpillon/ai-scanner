/** When a Scan Schedule starts its Scans (ADR-0014). */
export const CADENCES = ['interval', 'daily', 'weekly'] as const;
export type Cadence = (typeof CADENCES)[number];

export interface ScheduleTiming {
  cadence: Cadence;
  /** `interval`: hours between two Scans, 1 to 720. */
  intervalHours?: number | null;
  /** `daily`, `weekly`: `HH:MM`, wall-clock time in `timeZone`. */
  time?: string | null;
  /** `weekly`: days of the week, 0 (Sunday) to 6. */
  weekdays?: number[] | null;
  /** IANA name, e.g. `Europe/Rome`. */
  timeZone: string;
}

const HOUR_MS = 3_600_000;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** What is wrong with `timing`, or undefined when nothing is. */
export function timingProblem(timing: ScheduleTiming): string | undefined {
  if (!(CADENCES as readonly string[]).includes(timing.cadence)) return `cadence must be one of ${CADENCES.join(', ')}`;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timing.timeZone });
  } catch {
    return `Unknown time zone: ${timing.timeZone}`;
  }
  if (timing.cadence === 'interval') {
    const h = timing.intervalHours;
    if (!Number.isInteger(h) || h! < 1 || h! > 720) return 'intervalHours must be a whole number from 1 to 720';
    return undefined;
  }
  if (!timing.time || !TIME_PATTERN.test(timing.time)) return 'time must be HH:MM, 00:00 to 23:59';
  if (timing.cadence === 'weekly') {
    const days = timing.weekdays ?? [];
    if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return 'weekdays must list days from 0 (Sunday) to 6';
  }
  return undefined;
}

/** The wall-clock fields of `ms` in `timeZone`. */
function wallClock(ms: number, timeZone: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour'), mi: get('minute'), s: get('second') };
}

/** How far `timeZone` is ahead of UTC at `ms`. */
function offsetAt(ms: number, timeZone: string): number {
  const w = wallClock(ms, timeZone);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant a wall-clock time in `timeZone` falls on. A time skipped by a daylight-saving jump
 * lands just after it; a time that happens twice is the first one.
 */
export function zonedInstant(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  // The offsets before and after any change of offset that day.
  const before = offsetAt(guess - 12 * HOUR_MS, timeZone);
  const after = offsetAt(guess + 12 * HOUR_MS, timeZone);
  const fits = [guess - before, guess - after].filter((at) => {
    const w = wallClock(at, timeZone);
    return w.h === h && w.mi === mi;
  });
  // None fits in a gap: the offset from before it moves the time past the jump.
  return fits.length ? Math.min(...fits) : guess - before;
}

/** When the next Scan is due: strictly after `after`. */
export function nextRun(timing: ScheduleTiming, after: Date): Date {
  const now = after.getTime();
  if (timing.cadence === 'interval') return new Date(now + timing.intervalHours! * HOUR_MS);
  const [h, mi] = timing.time!.split(':').map(Number);
  const today = wallClock(now, timing.timeZone);
  // Eight days always hold a chosen weekday after today's time has passed.
  for (let i = 0; i <= 8; i++) {
    const day = new Date(Date.UTC(today.y, today.mo - 1, today.d + i));
    if (timing.cadence === 'weekly' && !timing.weekdays!.includes(day.getUTCDay())) continue;
    const at = zonedInstant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), h, mi, timing.timeZone);
    if (at > now) return new Date(at);
  }
  throw new Error('No next run within eight days');
}
