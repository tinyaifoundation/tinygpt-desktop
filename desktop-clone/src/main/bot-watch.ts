import { z } from 'zod';
import type { ScheduledStore } from './scheduled-store';

const inputSchema = z.object({ id: z.uuid().optional(), title: z.string().trim().min(1).max(120), prompt: z.string().trim().min(1).max(8000), minutes: z.number().int().min(30).max(10080) }).strict();
const normalized = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();
const samePrompt = (a: string, b: string) => a.trim() === b.trim();
const removalSchema = z.object({ id: z.uuid() }).strict();

/** Remove only an interest watch owned by the Bot. Retries cannot recreate it. */
export function removeBotWatch(store: ScheduledStore, raw: unknown, onlyId?: string) {
  const { id } = removalSchema.parse(raw);
  if (onlyId && id !== onlyId) throw Error('A proactive check can only remove its own watch.');
  const job = store.jobs().find(job => job.id === id);
  if (!job) return { id, removed: false, watching: false, unchanged: true, note: 'This watch is already absent. No watch was removed.' };
  if (job.owner !== 'bot') throw Error('This watch belongs to another feature.');
  if (normalized(job.title) === 'personal check-in') throw Error('Personal check-in is managed by the user’s Check in periodically setting.');
  store.remove(id);
  return { id, title: job.title, removed: true, watching: false };
}

export function saveBotWatch(store: ScheduledStore, raw: unknown) {
  const value = inputSchema.parse(raw);
  const old = value.id ? store.get(value.id) : store.jobs('bot').find(job => normalized(job.title) === normalized(value.title)) ?? store.jobs('bot').find(job => samePrompt(job.prompt, value.prompt) && job.schedule.minutes === value.minutes);
  if (old && old.owner !== 'bot') throw Error('This watch belongs to another feature.');
  if (normalized(value.title) === 'personal check-in' || old && normalized(old.title) === 'personal check-in') throw Error('Personal check-in is managed by the user’s Check in periodically setting. Create a specific interest watch instead; do not change the general check-in.');
  // An identical update must not postpone the check or silently unpause it.
  if (old && (!value.id || old.title === value.title) && samePrompt(old.prompt, value.prompt) && old.schedule.minutes === value.minutes) return { id: old.id, nextRunAt: old.nextRunAt, watching: old.enabled, unchanged: true, note: 'This watch is already saved. Continue the conversation; do not save it again.' };
  const job = store.save({ id: old?.id, revision: old?.revision, title: value.title, prompt: value.prompt, schedule: { repeat: 'interval', minutes: value.minutes, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, time: '09:00', weekday: 1 }, enabled: old?.enabled ?? true, newChat: false, mode: 'chat' }, 'bot');
  return { id: job.id, nextRunAt: job.nextRunAt, watching: job.enabled };
}
