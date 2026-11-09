import { describe, it, expect } from 'vitest';
import { nextOccurrence } from '../src/core/scheduled';
import { scheduleSchema, scheduledInputSchema } from '../src/shared/scheduled';
import { ScheduledStore } from '../src/main/scheduled-store';
import { mkdtemp, rm } from 'node:fs/promises';
import { join,resolve,dirname,basename } from 'node:path';
import { tmpdir } from 'node:os';

const daily = scheduleSchema.parse({ timezone: 'America/New_York', time: '09:00' });
const input = () => scheduledInputSchema.parse({ title: 'Morning briefing', prompt: 'Review my upcoming day.', schedule: daily });
describe('wall-clock schedules', () => {
  it('keeps local time across the spring DST transition', () => {
    expect(new Date(nextOccurrence(daily,Date.parse('2026-03-07T15:00:00Z'))!).toISOString()).toBe('2026-03-08T13:00:00.000Z');
  });
  it('skips a nonexistent local time and does not repeat the fall-back hour', () => {
    expect(new Date(nextOccurrence({ ...daily,time: '02:30' },Date.parse('2026-03-08T06:00:00Z'))!).toISOString()).toBe('2026-03-09T06:30:00.000Z');
    expect(new Date(nextOccurrence({ ...daily,time: '01:30' },Date.parse('2026-11-01T05:30:00Z'))!).toISOString()).toBe('2026-11-02T06:30:00.000Z');
  });
  it('skips weekends and validates one-time dates and timezone names', () => {
    expect(new Date(nextOccurrence({ ...daily,repeat: 'weekdays' },Date.parse('2026-11-06T15:00:00Z'))!).toISOString()).toBe('2026-11-09T14:00:00.000Z');
    expect(scheduleSchema.safeParse({ timezone: 'made-up' }).success).toBe(false);
    expect(scheduleSchema.safeParse({ repeat: 'once' }).success).toBe(false);
  });
});
describe('persistent task admission', () => {
  it('recovers interrupted runs and a pending proactive delivery after reopening', async () => {
    const directory = await mkdtemp(join(tmpdir(),'tinygpt-schedule-recovery-')), path = join(directory,'scheduled.sqlite');
    let store = new ScheduledStore(path);
    try {
      const job = store.save(input(),'bot',0), run = store.claim(job.id,Date.now())!; store.complete(run.id,'A useful finding.',true);
      const pending = store.claim(job.id,Date.now()+1,true)!; store.close(); store = new ScheduledStore(path);
      expect(store.get(job.id).title).toBe('Morning briefing'); expect(store.runs().find(run => run.id === pending.id)?.status).toBe('interrupted');
      expect(JSON.parse(store.metadata('bot-deliveries')!)[0]).toEqual({ runId: run.id,text: 'A useful finding.' });
    } finally { store.close(); const target = resolve(directory); if (dirname(target).toLowerCase() !== resolve(tmpdir()).toLowerCase() || !basename(target).startsWith('tinygpt-schedule-recovery-')) throw Error('Unexpected fixture directory'); await rm(target,{ recursive:true,force:true }); }
  });
  it('claims a missed occurrence once and advances from the present, without a catch-up storm', () => {
    const store = new ScheduledStore(':memory:');
    try { const job = store.save(input(),'user',Date.parse('2026-11-01T15:00:00Z')); const now = Date.parse('2026-11-05T16:00:00Z');
      const run = store.claim(job.id,now)!; expect(run.dueAt).toBe(Date.parse('2026-11-02T14:00:00Z'));
      expect(store.claim(job.id,now)).toBeUndefined();
      expect(store.get(job.id).nextRunAt).toBe(Date.parse('2026-11-06T14:00:00Z'));
      store.finish(run.id,'complete',null,'Briefing prepared'); expect(store.runs()[0].summary).toBe('Briefing prepared');
    } finally { store.close(); }
  });
  it('keeps bot watches out of user schedules and enforces ownership/revision', () => {
    const store = new ScheduledStore(':memory:');
    try { const user = store.save(input()), bot = store.save({ ...input(),title: 'Watch an interest' },'bot');
      expect(store.jobs('user').map(job => job.id)).toEqual([user.id]); expect(store.jobs('bot')[0].id).toBe(bot.id);
      expect(() => store.save({ ...store.input(bot),title: 'Wrong owner' })).toThrow();
      store.enabled(user.id,false); expect(() => store.save(store.input(user))).toThrow('changed');
      expect(store.get(user.id).nextRunAt).toBeNull();
    } finally { store.close(); }
  });
  it('allows one manual attempt while paused and prevents overlapping executions', () => {
    const store = new ScheduledStore(':memory:');
    try { const job = store.save({ ...input(),enabled: false });
      expect(store.claim(job.id)).toBeUndefined(); const run = store.claim(job.id,1000,true)!;
      expect(run.status).toBe('running'); expect(store.claim(job.id,2000,true)).toBeUndefined();
      store.finish(run.id,'error','Provider unavailable'); expect(store.get(job.id).enabled).toBe(false);
      expect(store.claim(job.id,3000,true)?.status).toBe('running');
    } finally { store.close(); }
  });
});
