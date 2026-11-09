import { z } from 'zod';
export const botConfigurationSchema = z.object({
  commands: z.enum(['ask', 'deny', 'full']).default('ask'),
  files: z.enum(['workspace', 'computer']).default('workspace'),
  browser: z.boolean().default(false),
  memory: z.boolean().default(true),
  background: z.boolean().default(false),
  heartbeat: z.enum(['off', '30m', '1h']).default('off'),
}).strict();
export type BotConfiguration = z.infer<typeof botConfigurationSchema>;
export const defaultBotConfiguration = botConfigurationSchema.parse({});
export const botNoteFileSchema = z.enum(['SOUL.md', 'USER.md', 'AGENTS.md', 'MEMORY.md']);
export const botNoteSchema = z.object({ file: botNoteFileSchema, text: z.string().max(32000) }).strict();
export type BotNote = { file: z.infer<typeof botNoteFileSchema>; text: string; editable: boolean };
export interface BotJob { id: string; name: string; enabled: boolean; nextRunAt: number | null; running?: boolean }
export const botJobActionSchema = z.object({ id: z.uuid(), action: z.enum(['pause', 'resume', 'run', 'remove']) }).strict();
export const botSetupSchema = z.object({ name: z.string().trim().min(1).max(40), projectId: z.uuid().nullable().default(null), configuration: botConfigurationSchema.optional() }).strict();
export type BotSetup = z.infer<typeof botSetupSchema>;
export interface BotSnapshot { configured: boolean; conversationId: string | null; projectId: string | null; configuration?: BotConfiguration; snoozed?: boolean; phase: 'idle' | 'preparing' | 'ready' | 'error'; error?: string }
export const BOT_SLEEPING_MESSAGE = 'Your bot is sleeping. Wake it to resume replies and watches.';
export const BOT_RUNTIME_ERROR = 'Your bot could not connect. Your messages are saved. Try again.';
export interface BotPluginAccess {
  readBlocked: boolean;
  plugins: { id: string; name: string; connector?: import('./plugins').SuggestedConnector; account?: string; connected: boolean; allowed: boolean }[];
}
