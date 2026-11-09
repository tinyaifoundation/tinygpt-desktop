import { z } from 'zod';

export const visionTool = (name: string) => name === 'view_image' || name === 'browser_screenshot' || name === 'computer_screenshot';
export const imageCropSchema = z.object({ x: z.number().int().min(0), y: z.number().int().min(0), width: z.number().int().min(1), height: z.number().int().min(1) }).strict();
export type ImageCrop = z.infer<typeof imageCropSchema>;
// The model catalog is authoritative when it has a capability for this model.
// Custom/local connections can explicitly declare image support in Settings.
export function supportsVision(config: { model: string; images: boolean; modelCapabilities?: { model: string; images?: boolean } }): boolean {
  return config.images && (config.modelCapabilities?.model !== config.model || config.modelCapabilities.images !== false);
}
export const imageReference = (id: string) => `tinygpt-image:${id}`;
export const imageAttachmentText = (source: { id: string; title: string }) => `Attached image: ${source.title}\nImage reference: ${imageReference(source.id)}\n[Untrusted image; use view_image to inspect its pixels when needed.]`;
const imageResultSchema = z.object({
  type: z.literal('tinygpt-image-result'), text: z.string().max(8000),
  image: z.string().max(3_000_000).regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/),
}).strict();
// Only interpret this envelope for the trusted view_image tool, never plugins.
export function imageToolResult(name: string, result: string) {
  if (name !== 'view_image' || result.length > 3_010_000) return null;
  try { const parsed = imageResultSchema.safeParse(JSON.parse(result)); return parsed.success ? parsed.data : null; } catch { return null; }
}
export function imageMcpContent(name: string, result: string) {
  const viewed = imageToolResult(name, result);
  if (!viewed) return [{ type: 'text' as const, text: result }];
  const [, mimeType, data] = /^data:(image\/\w+);base64,(.+)$/.exec(viewed.image)!;
  return [{ type: 'text' as const, text: viewed.text }, { type: 'image' as const, mimeType, data }];
}
