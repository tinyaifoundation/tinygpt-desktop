import { z } from 'zod';
import { memoryInputSchema } from './memory';

const title=z.string().trim().min(1).max(120);
export const remoteManagementRequestSchema=z.discriminatedUnion('op',[
 z.object({id:z.uuid(),op:z.literal('state')}).strict(),
 z.object({id:z.uuid(),op:z.literal('voice'),enabled:z.boolean().optional(),voice:z.string().min(1).max(200).optional(),dictation:z.boolean().optional()}).strict(),
 z.object({id:z.uuid(),op:z.literal('keep-awake'),value:z.boolean()}).strict(),
 z.object({id:z.uuid(),op:z.literal('plugin'),pluginId:z.uuid(),action:z.enum(['enable','disable','disconnect'])}).strict(),
 z.object({id:z.uuid(),op:z.literal('project-open'),projectId:z.uuid()}).strict(),
 z.object({id:z.uuid(),op:z.literal('project-save'),projectId:z.uuid().optional(),name:title,instructions:z.string().trim().max(12000)}).strict(),
 z.object({id:z.uuid(),op:z.literal('project-move'),conversationId:z.uuid(),projectId:z.uuid().nullable()}).strict(),
 z.object({id:z.uuid(),op:z.literal('project-chat'),projectId:z.uuid(),mode:z.enum(['chat','code'])}).strict(),
 z.object({id:z.uuid(),op:z.literal('memory-open'),memoryId:z.uuid()}).strict(),
 z.object({id:z.uuid(),op:z.literal('memory-save'),input:memoryInputSchema}).strict(),
 z.object({id:z.uuid(),op:z.literal('memory-delete'),memoryId:z.uuid()}).strict(),
 z.object({id:z.uuid(),op:z.literal('memory-sharing'),value:z.boolean()}).strict(),
]);
export type RemoteManagementRequest=z.infer<typeof remoteManagementRequestSchema>;
export const remoteManagementStateSchema=z.object({
 allowed:z.boolean(),computer:z.string().max(120),version:z.string().max(100),keepAwake:z.boolean(),
 voice:z.object({enabled:z.boolean(),local:z.boolean(),dictation:z.boolean(),voice:z.string().max(200),voices:z.array(z.object({id:z.string().max(200),name:z.string().max(120)}).strict()).max(100)}).strict().optional(),
 plugins:z.array(z.object({id:z.uuid(),name:z.string().max(120),description:z.string().max(400),enabled:z.boolean(),status:z.enum(['disabled','disconnected','connecting','connected','error'])}).strict()).max(100).optional(),
 projects:z.array(z.object({id:z.uuid(),name:z.string().max(120),chats:z.number().int().min(0)}).strict()).max(200).optional(),
 memories:z.array(z.object({id:z.uuid(),projectId:z.uuid().nullable(),title:z.string().max(200),enabled:z.boolean(),updatedAt:z.number()}).strict()).max(200).optional(),
 personalMemory:z.boolean().optional(),
 activity:z.array(z.object({conversationId:z.uuid(),title:z.string().max(120),running:z.boolean(),phase:z.string().max(40),queued:z.number().int().min(0),attention:z.boolean()}).strict()).max(300).optional(),
 project:z.object({id:z.uuid(),name:z.string().max(120),instructions:z.string().max(12000),conversationIds:z.array(z.uuid()).max(300)}).strict().optional(),
 memory:memoryInputSchema.extend({id:z.uuid()}).optional(),
 conversationId:z.uuid().optional(),
}).strict();
export type RemoteManagementState=z.infer<typeof remoteManagementStateSchema>;
