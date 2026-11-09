import { z } from 'zod';
import { settingsSchema, type Settings } from './config';

export const inferenceConnectionSchema = z.discriminatedUnion('route', [
  z.object({ id: z.uuid(), route: z.literal('byok'), name: z.string().min(1).max(200), config: settingsSchema.shape.byok }).strict(),
  z.object({ id: z.uuid(), route: z.literal('local'), name: z.string().min(1).max(200), config: settingsSchema.shape.local }).strict(),
]);
export const inferenceRegistrySchema = z.object({
  connections: z.array(inferenceConnectionSchema).max(100),
  selected: z.object({ byok: z.uuid().optional(), local: z.uuid().optional() }).strict(),
}).strict();
export type InferenceConnection = z.infer<typeof inferenceConnectionSchema>;
export type InferenceRegistry = z.infer<typeof inferenceRegistrySchema>;
export const providerNames: Record<Settings['byok']['provider'], string> = {
  openai: 'OpenAI', anthropic: 'Anthropic', xai: 'xAI', openrouter: 'OpenRouter', custom: 'Custom provider',
};
export function connectionSettings(settings: Settings, connection: InferenceConnection): Settings {
  return { ...settings, route: connection.route, [connection.route]: connection.config };
}
