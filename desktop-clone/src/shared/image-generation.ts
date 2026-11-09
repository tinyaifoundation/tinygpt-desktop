import { z } from 'zod';
export const imageSelectionSchema = z.object({ connectionId: z.uuid(), model: z.string().min(1).max(200) }).strict();
export type ImageSelection = z.infer<typeof imageSelectionSchema>;
export interface ImageModel extends ImageSelection { name: string; provider: string; adapter: 'openai' | 'openrouter' | 'xai'; editing: boolean; transparency: boolean; mask: boolean }
export interface ImageCatalog { models: ImageModel[]; issues: string[]; selected?: ImageSelection }
export const rasterSchema = z.string().max(32_000_000).regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/);
export const generateImageSchema = z.object({ prompt: z.string().trim().min(1).max(16000), title: z.string().trim().min(1).max(120), reference: z.string().regex(/^tinygpt-image:[a-f0-9-]{36}$/).optional(), transparent: z.boolean().optional() }).strict();
export const imageActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('edit'), conversationId: z.uuid(), sourceId: z.uuid(), jobId: z.uuid(), prompt: z.string().trim().min(1).max(16000), model: imageSelectionSchema, reference: rasterSchema.optional(), mask: rasterSchema.optional(), transparent: z.boolean().optional() }).strict(),
  z.object({ action: z.literal('save'), conversationId: z.uuid(), sourceId: z.uuid(), image: rasterSchema, label: z.string().min(1).max(120) }).strict(),
  z.object({ action: z.literal('resize'), conversationId: z.uuid(), sourceId: z.uuid(), width: z.number().int().min(1).max(4096), height: z.number().int().min(1).max(4096) }).strict(),
  z.object({ action: z.enum(['download', 'copy']), conversationId: z.uuid(), sourceId: z.uuid() }).strict(),
  z.object({ action: z.literal('cancel'), jobId: z.uuid() }).strict(),
]);
export type ImageAction = z.infer<typeof imageActionSchema>;
export function sameImageModel(a: ImageSelection | undefined, b: ImageSelection) { return a?.connectionId === b.connectionId && a.model === b.model; }
