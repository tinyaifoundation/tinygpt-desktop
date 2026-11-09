import { z } from 'zod';

const base = z.object({ id: z.uuid(), conversationId: z.uuid(), jobId: z.uuid() });
export const remoteVoiceRequestSchema = z.discriminatedUnion('op', [
  base.extend({ op: z.literal('dictation-start'), sampleRate: z.number().int().min(8000).max(48000) }).strict(),
  base.extend({ op: z.literal('dictation-audio'), sequence: z.number().int().min(0), audio: z.string().max(65536).regex(/^[A-Za-z0-9+/]*={0,2}$/) }).strict(),
  base.extend({ op: z.literal('dictation-stop'), cancel: z.boolean().default(false) }).strict(),
  base.extend({ op: z.literal('speech-read'), messageId: z.uuid(), chunk: z.number().int().min(0).max(10000) }).strict(),
  base.extend({op:z.literal('speech-preview')}).strict(),
  base.extend({ op: z.literal('speech-next'), sequence: z.number().int().min(1).max(1000000) }).strict(),
  base.extend({ op: z.literal('speech-cancel') }).strict(),
]);
export type RemoteVoiceRequest = z.infer<typeof remoteVoiceRequestSchema>;
export const remoteVoiceCapabilitiesSchema = z.object({ dictation: z.boolean(), readAloud: z.boolean(), speed: z.number().min(.5).max(2) });
export type RemoteVoiceCapabilities = z.infer<typeof remoteVoiceCapabilitiesSchema>;
export const noRemoteVoice: RemoteVoiceCapabilities = { dictation: false, readAloud: false, speed: 1 };
