import { nextRun, ScheduleTiming, timingProblem, zonedInstant } from '../src/schedules/schedule-timing';

const at = (iso: string) => new Date(iso);
const next = (timing: Omit<ScheduleTiming, 'timeZone'> & { timeZone?: string }, after: string) =>
  nextRun({ timeZone: 'UTC', ...timing }, at(after)).toISOString();

describe('When a Scan Schedule runs next', () => {
  it('runs every N hours from now', () => {
    expect(next({ cadence: 'interval', intervalHours: 6 }, '2026-03-10T10:15:00Z')).toBe('2026-03-10T16:15:00.000Z');
  });

  it('runs daily at a time, today if it has not passed, tomorrow otherwise', () => {
    expect(next({ cadence: 'daily', time: '02:30' }, '2026-03-10T01:00:00Z')).toBe('2026-03-10T02:30:00.000Z');
    expect(next({ cadence: 'daily', time: '02:30' }, '2026-03-10T02:30:00Z')).toBe('2026-03-11T02:30:00.000Z');
  });

  it('runs weekly on the chosen days', () => {
    // 2026-03-10 is a Tuesday.
    expect(next({ cadence: 'weekly', time: '09:00', weekdays: [1, 5] }, '2026-03-10T08:00:00Z')).toBe('2026-03-13T09:00:00.000Z');
    expect(next({ cadence: 'weekly', time: '09:00', weekdays: [2] }, '2026-03-10T10:00:00Z')).toBe('2026-03-17T09:00:00.000Z');
  });

  it('reads the time in the schedule time zone, daylight saving included', () => {
    // Rome is UTC+1 in winter, UTC+2 in summer.
    expect(next({ cadence: 'daily', time: '02:30', timeZone: 'Europe/Rome' }, '2026-01-10T00:00:00Z')).toBe('2026-01-10T01:30:00.000Z');
    expect(next({ cadence: 'daily', time: '02:30', timeZone: 'Europe/Rome' }, '2026-07-10T00:00:00Z')).toBe('2026-07-10T00:30:00.000Z');
  });

  it('moves a time skipped by daylight saving just past the jump, and takes the first of a time that happens twice', () => {
    // Rome skips 02:00-03:00 on 2026-03-29 and repeats 02:00-03:00 on 2026-10-25.
    expect(new Date(zonedInstant(2026, 3, 29, 2, 30, 'Europe/Rome')).toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(new Date(zonedInstant(2026, 10, 25, 2, 30, 'Europe/Rome')).toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });

  it.each([
    [{ cadence: 'hourly' }, /cadence must be/],
    [{ cadence: 'interval', intervalHours: 0 }, /intervalHours/],
    [{ cadence: 'daily', time: '24:00' }, /HH:MM/],
    [{ cadence: 'weekly', time: '10:00', weekdays: [] }, /weekdays/],
    [{ cadence: 'weekly', time: '10:00', weekdays: [7] }, /weekdays/],
    [{ cadence: 'daily', time: '10:00', timeZone: 'Mars/Olympus' }, /Unknown time zone/],
  ])('refuses %j', (timing, message) => {
    expect(timingProblem({ timeZone: 'UTC', ...timing } as ScheduleTiming)).toMatch(message);
  });
});
