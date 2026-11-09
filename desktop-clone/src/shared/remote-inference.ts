import { z } from 'zod';
import { effortSchema } from './effort';

// Only display identities cross the relay. Endpoints, credentials and full
// provider configuration remain in the desktop process.
const modelId = z.string().min(1).max(300);
export const remoteInferenceStateSchema = z.object({
  connectionId: z.uuid().optional(), model: z.string().max(300), name: z.string().max(300),
  effort: z.object({ chat: effortSchema, code: effortSchema }).strict(),
  connections: z.array(z.object({ id: z.uuid(), name: z.string().max(200), provider: z.enum(['local','openai','anthropic','xai','openrouter','custom']).optional(), builtIn: z.enum(['included','pro']).optional() }).strict()).max(100),
}).strict();
export type RemoteInferenceState = z.infer<typeof remoteInferenceStateSchema>;
export const remoteModelCatalogSchema = z.object({ models: z.array(z.object({ id: modelId, name: z.string().max(300) }).strict()).max(5000) }).strict();
export type RemoteModelCatalog = z.infer<typeof remoteModelCatalogSchema>;
export const remoteInferenceRequestSchema = z.discriminatedUnion('op', [
  z.object({ id: z.uuid(), op: z.literal('models'), connectionId: z.uuid() }).strict(),
  z.object({ id: z.uuid(), op: z.literal('select'), connectionId: z.uuid(), model: modelId }).strict(),
  z.object({ id: z.uuid(), op: z.literal('effort'), mode: z.enum(['chat','code']), effort: effortSchema }).strict(),
]);
export type RemoteInferenceRequest = z.infer<typeof remoteInferenceRequestSchema>;
