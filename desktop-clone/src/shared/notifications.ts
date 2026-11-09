import { z } from 'zod';

const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const notificationPreferencesSchema = z.object({
  desktop: z.boolean().default(true),
  onlyWhenAway: z.boolean().default(true),
  previews: z.boolean().default(false),
  badges: z.boolean().default(true),
  paused: z.boolean().default(false),
  events: z.object({ chat: z.boolean().default(true), work: z.boolean().default(true), bot: z.boolean().default(true), attention: z.boolean().default(true), errors: z.boolean().default(true) }).strict().default({ chat: true, work: true, bot: true, attention: true, errors: true }),
  sound: z.object({ enabled: z.boolean().default(false), volume: z.number().min(0).max(1).default(.35), source: z.enum(['default', 'custom']).default('default') }).strict().default({ enabled: false, volume: .35, source: 'default' }),
  quietHours: z.object({ enabled: z.boolean().default(false), start: time.default('22:00'), end: time.default('08:00') }).strict().default({ enabled: false, start: '22:00', end: '08:00' }),
}).strict();
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;
export type NotificationKind = 'completed' | 'attention' | 'failed';
export interface ActivityNotification {
  id: string; sequence: number; conversationId: string; messageId: string | null;
  kind: NotificationKind; mode: 'chat' | 'code' | 'bot'; title: string; detail: string;
  createdAt: number; read: boolean; resolved: boolean;
}
export interface NotificationSnapshot {
  items: ActivityNotification[]; unreadCount: number; unreadConversationIds: string[]; unreadCounts: Record<string, number>;
  desktopSupported: boolean; deliveryError: string | null; customSoundName: string | null;
}
export const notificationActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read'), id: z.uuid() }).strict(),
  z.object({ action: z.literal('dismiss'), id: z.uuid() }).strict(),
  z.object({ action: z.literal('read-all'), throughSequence: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal('clear-read') }).strict(),
  z.object({ action: z.literal('open'), id: z.uuid() }).strict(),
]);
export type NotificationAction = z.infer<typeof notificationActionSchema>;
export const notificationViewSchema = z.object({ conversationId: z.uuid().nullable(), visible: z.boolean() }).strict();
export interface NotificationSound { id: string; url: string; volume: number }
export const notificationSoundResultSchema = z.object({ id: z.uuid(), played: z.boolean() }).strict();

export function inQuietHours(preferences: NotificationPreferences, now = new Date()): boolean {
  const quiet = preferences.quietHours; if (!quiet.enabled) return false;
  const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const start = minutes(quiet.start), end = minutes(quiet.end), current = now.getHours() * 60 + now.getMinutes();
  return start === end || (start < end ? current >= start && current < end : current >= start || current < end);
}
export const notificationErrors = [
  'Choose a WAV or MP3 notification sound smaller than 5 MB.',
  'This sound could not be read. Choose a WAV or MP3 file.',
  'Choose a custom sound first.',
  'Notification sound could not play. Try another WAV or MP3 file.',
  'The notification sound player is not ready. Try again.',
  'This notification is no longer available.',
];
