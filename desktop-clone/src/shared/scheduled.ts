import { z } from 'zod';
export const scheduleSuggestionCount = 6;

export const scheduleSchema = z.object({
  repeat: z.enum(['once', 'hourly', 'daily', 'weekdays', 'weekly', 'interval']).default('daily'),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('09:00'),
  timezone: z.string().max(100).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }).default('America/New_York'),
  weekday: z.number().int().min(0).max(6).default(1),
  at: z.number().int().positive().optional(),
  minutes: z.number().int().min(15).max(10080).default(60),
}).strict().refine(value => value.repeat !== 'once' || !!value.at, 'Choose a date and time.');
export const scheduledInputSchema = z.object({
  id: z.uuid().optional(), revision: z.number().int().nonnegative().optional(),
  title: z.string().trim().min(1).max(120), prompt: z.string().trim().min(1).max(32000),
  schedule: scheduleSchema,
  enabled: z.boolean().default(true), newChat: z.boolean().default(false),
  mode: z.enum(['chat', 'code']).default('chat'),
}).strict();
export type Schedule = z.infer<typeof scheduleSchema>;
export type ScheduledInput = z.infer<typeof scheduledInputSchema>;
export interface ScheduledJob extends Omit<ScheduledInput, 'id' | 'revision'> {
  id: string; revision: number; owner: 'user' | 'bot'; conversationId: string | null;
  nextRunAt: number | null; createdAt: number; updatedAt: number;
}
export interface ScheduledRun {
  id: string; jobId: string; dueAt: number; startedAt: number; finishedAt: number | null;
  status: 'running' | 'complete' | 'error' | 'interrupted' | 'cancelled';
  conversationId: string | null; error: string | null; summary: string;
}
export interface ScheduledSnapshot { jobs: ScheduledJob[]; runs: ScheduledRun[]; suggestions: ScheduleSuggestion[]; generating: boolean; suggestionError?: string }
export const suggestionSchema = z.object({ title: z.string().trim().min(1).max(100), description: z.string().trim().min(1).max(240), prompt: z.string().trim().min(1).max(4000), emoji: z.string().max(12).default('✨'), repeat: z.enum(['daily', 'weekdays', 'weekly']).default('daily') }).strict();
export type ScheduleSuggestion = z.infer<typeof suggestionSchema>;
export const scheduledActionSchema = z.object({ id: z.uuid(), action: z.enum(['pause', 'resume', 'remove', 'run', 'stop']) }).strict();
