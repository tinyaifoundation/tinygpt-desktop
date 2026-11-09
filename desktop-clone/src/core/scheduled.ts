import type { Schedule } from '../shared/scheduled';

/** Match local wall-clock minutes against UTC instants: nonexistent DST times
 * are skipped and a repeated local hour is admitted only once per local day. */
export function nextOccurrence(schedule: Schedule, after: number): number | null {
  if (schedule.repeat === 'once') return schedule.at! > after ? schedule.at! : null;
  if (schedule.repeat === 'interval') return after + schedule.minutes * 60000;
  if (schedule.repeat === 'hourly') return Math.floor(after / 3600000) * 3600000 + 3600000;
  const format = new Intl.DateTimeFormat('en-US', { timeZone: schedule.timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
  const parts = (at: number) => Object.fromEntries(format.formatToParts(at).map(part => [part.type, part.value]));
  const previous = parts(after), [hour, minute] = schedule.time.split(':');
  const sameDay = (a: Record<string, string>, b: Record<string, string>) => a.year === b.year && a.month === b.month && a.day === b.day;
  for (let at = Math.floor(after / 60000) * 60000 + 60000, end = after + 9 * 86400000; at <= end; at += 60000) {
    const local = parts(at);
    if (local.hour !== hour || local.minute !== minute) continue;
    if (previous.hour === hour && previous.minute >= minute && sameDay(previous, local)) continue;
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(local.weekday);
    if (schedule.repeat === 'weekdays' && (weekday === 0 || weekday === 6) || schedule.repeat === 'weekly' && weekday !== schedule.weekday) continue;
    return at;
  }
  return null;
}

export function scheduleLabel(schedule: Schedule): string {
  if (schedule.repeat === 'once') return new Date(schedule.at!).toLocaleString();
  if (schedule.repeat === 'hourly') return 'Every hour';
  if (schedule.repeat === 'interval') return `Every ${schedule.minutes} minutes`;
  const day = schedule.repeat === 'weekly' ? `Every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][schedule.weekday]}` : schedule.repeat === 'weekdays' ? 'Weekdays' : 'Daily';
  return `${day} at ${schedule.time} · ${schedule.timezone.replaceAll('_', ' ')}`;
}
