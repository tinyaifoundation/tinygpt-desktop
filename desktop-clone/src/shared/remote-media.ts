import { z } from 'zod';
export const REMOTE_FILE_BYTES = 8 * 1024 * 1024;
const base = z.object({id:z.uuid(),conversationId:z.uuid(),jobId:z.uuid()});
export const remoteMediaRequestSchema = z.discriminatedUnion('op',[
  base.extend({op:z.literal('upload-start'),name:z.string().min(1).max(180),bytes:z.number().int().min(1).max(REMOTE_FILE_BYTES)}).strict(),
  base.extend({op:z.literal('upload-chunk'),sequence:z.number().int().min(0).max(512),data:z.string().min(4).max(65536).regex(/^[A-Za-z0-9+/]+={0,2}$/)}).strict(),
  base.extend({op:z.literal('upload-finish')}).strict(),base.extend({op:z.literal('upload-cancel')}).strict(),
  base.extend({op:z.literal('tool-image'),toolId:z.uuid()}).strict(),
  base.extend({op:z.literal('tool-ui'),toolId:z.uuid()}).strict(),
  base.extend({op:z.literal('attachment-image'),sourceId:z.uuid(),size:z.enum(['thumbnail','full']).optional()}).strict(),
  base.extend({op:z.literal('remove-upload'),sourceId:z.uuid()}).strict(),
]);
export type RemoteMediaRequest = z.infer<typeof remoteMediaRequestSchema>;
export interface ToolImagePreview { image:string; title:string; width:number; height:number }
export interface RemoteUpload { sourceId:string; title:string; mime:string; size:number }
