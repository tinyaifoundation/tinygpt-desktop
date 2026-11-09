import { remoteTool } from '../core/remote-tool';
import {botDesignSchema,type RemoteBotState} from './bot-design';
import {botReactionEmojiSchema} from './bot-reactions';
import { remoteWork } from '../core/remote-work';
import { z } from 'zod';
import type { ChatUpdate, ChatMessage } from './chat';
import { collectCitations } from '../core/citations';
import { queueActionSchema } from './chat';
export const REMOTE_DRAFT_ID = '00000000-0000-4000-8000-000000000000';

export const REMOTE_VERSION = 1;
export const REMOTE_APPEARANCE_KEYS = ['--background', '--foreground', '--user-accent', '--ring', '--user-ui-font', '--user-content-font', '--user-code-font', '--user-ui-weight', '--user-content-weight', '--user-code-weight', '--user-ui-size', '--user-code-size', '--user-ui-scale', '--user-contrast'] as const;
const remoteVariablesSchema = z.record(z.enum(REMOTE_APPEARANCE_KEYS), z.string().max(200).regex(/^[#\w\s"'.,%()-]+$/));
export const remoteAppearanceSchema = z.object({ theme: z.enum(['light', 'dark']), variables: remoteVariablesSchema, bot:botDesignSchema.optional(), palettes: z.object({ light: remoteVariablesSchema, dark: remoteVariablesSchema }).strict().optional() }).strict();
export type RemoteAppearance = z.infer<typeof remoteAppearanceSchema>;
export const remoteCommandSchema = z.discriminatedUnion('op', [
  z.object({id:z.uuid(),op:z.literal('bot-snooze'),conversationId:z.uuid(),snoozed:z.boolean()}).strict(),
  z.object({id:z.uuid(),op:z.literal('bot-react'),conversationId:z.uuid(),messageId:z.uuid(),emoji:botReactionEmojiSchema.nullable()}).strict(),
  z.object({ id: z.uuid(), op: z.literal('warm'), conversationId: z.uuid().optional() }).strict(),
  z.object({ id: z.uuid(), op: z.literal('get'), conversationId: z.uuid().optional(), home: z.boolean().optional() }).strict(),
  z.object({ id: z.uuid(), op: z.literal('send'), conversationId: z.uuid().optional(), text: z.string().trim().max(32000), attachmentIds:z.array(z.uuid()).max(8).optional(), delivery: z.enum(['queue', 'steer']).optional() }).strict().refine(value => !!value.text || !!value.attachmentIds?.length,'Add a message or attachment.'),
  z.object({ id: z.uuid(), op: z.literal('stop'), conversationId: z.uuid().optional() }).strict(),
  z.object({ id: z.uuid(), op: z.literal('create'), mode: z.enum(['chat', 'code']) }).strict(),
  z.object({ id: z.uuid(), op: z.literal('edit'), conversationId: z.uuid(), messageId: z.uuid(), text: z.string().trim().min(1).max(32000) }).strict(),
  z.object({ id: z.uuid(), op: z.literal('regenerate'), conversationId: z.uuid(), messageId: z.uuid() }).strict(),
  z.object({ id: z.uuid(), op: z.literal('branch'), conversationId: z.uuid(), messageId: z.uuid() }).strict(),
  z.object({ id: z.uuid(), op: z.literal('approve'), conversationId: z.uuid(), approvalId: z.uuid(), decision: z.enum(['allow-once', 'deny']) }).strict(),
  z.object({ id: z.uuid(), op: z.literal('answer'), conversationId: z.uuid(), questionId: z.uuid(), optionId: z.string().min(1).max(40).optional(), text: z.string().trim().min(1).max(4000).optional() }).strict(),
  z.object({ id: z.uuid(), op: z.literal('rename'), conversationId: z.uuid(), title: z.string().trim().min(1).max(120) }).strict(),
  z.object({ id: z.uuid(), op: z.literal('organize'), conversationId: z.uuid(), action: z.enum(['pin', 'archive']), value: z.boolean() }).strict(),
  z.object({ id: z.uuid(), op: z.literal('delete'), conversationId: z.uuid() }).strict(),
  z.object({ id: z.uuid(), op: z.literal('notification-read'), conversationId: z.uuid(), notificationId: z.uuid() }).strict(),
  z.object({ id: z.uuid(), op: z.literal('queue'), conversationId: z.uuid(), change: queueActionSchema }).strict().refine(value => value.conversationId === value.change.conversationId, 'Queue target mismatch.'),
]);
export type RemoteCommand = z.infer<typeof remoteCommandSchema>;
export type RemoteScope = 'conversation' | 'library';
export interface RemoteDevice { management?:boolean; scope?: RemoteScope; id: string; name: string; conversationId: string; grantId: string; createdAt: number; expiresAt: number }
export interface RemotePairingRequest { id: string; name: string; grantId: string; expiresAt: number }
export interface RemoteStatus { configured: boolean; connected: boolean; enabled: boolean; keepAwake: boolean; relayUrl: string; devices: RemoteDevice[]; requests?: RemotePairingRequest[]; error?: string }
export const remotePreferencesSchema = z.object({ enabled: z.boolean().optional(), keepAwake: z.boolean().optional() }).strict();
export type RemotePreferences = z.infer<typeof remotePreferencesSchema>;
export interface RemoteInvitation { id: string; url: string; qr: string; expiresAt: number }

/** Project metadata, credentials and raw tool results stay local; approval details are scoped to this conversation. */
export function remoteView(update: ChatUpdate, libraryAccess = false, iconKeys: Readonly<Record<string, string>> = {}, bot?:RemoteBotState): ChatUpdate {
  const original = update.conversation;
  const personalBot=bot&&(libraryAccess||original.id===bot.conversationId)?bot:undefined;
  const visibleConversation=(chat:{id:string;mode?:string})=>chat.mode!=='bot'||chat.id===personalBot?.conversationId;
  if(original.mode==='bot'&&!visibleConversation(original))throw Error('This Bot conversation is unavailable.');
  const work=remoteWork(original.tools,original.allMessages??original.messages);
  const byId = new Map((original.allMessages ?? original.messages).map(message => [message.id, message]));
  const projectMessage = (message: ChatMessage): ChatMessage => {
    const runs = new Set([message.runId]); let prior = message.continuationOf; const seen = new Set<string>();
    while (prior && !seen.has(prior)) { seen.add(prior); const previous = byId.get(prior); if (!previous) break; runs.add(previous.runId); prior = previous.continuationOf; }
    const citations = message.role === 'assistant' ? collectCitations(original.tools.filter(tool => tool.conversationId === original.id && runs.has(tool.runId)), original.sources, message.text).slice(0,32).map(source => ({ ...source, title: source.title.slice(0,500), snippet: source.snippet.slice(0,600) })) : [];
    return {
      id: message.id, attachmentIds: message.attachmentIds?.slice(0,8), parentId: message.parentId, continuationOf: message.continuationOf, role: message.role, text: message.text.slice(-100000), reasoning: message.reasoning?.slice(-12000),
      reactions:message.reactions?.slice(0,2).map(item=>({...item})), status: message.status, error: message.error?.slice(0,2000) ?? null, createdAt: message.createdAt, runId: message.runId, route: message.route, workDurationMs: message.workDurationMs,
      ...(citations.length ? { citations } : {}),
      presentations: message.presentations?.filter(item => work.tools.some(tool => tool.name === 'present' && tool.id === item.toolId)).map(item => ({toolId:item.toolId,offset:Math.max(0,item.offset-Math.max(0,message.text.length-100000))})),
      workActivity: work.activity(message),
      workTask: message.workTask ? { id: message.workTask.id, conversationId: original.id, messageId: message.workTask.messageId, runId: message.workTask.runId, revision: message.workTask.revision, status: message.workTask.status, goal: message.workTask.goal.slice(0,2000), steps: [], criteria: [], summary: message.workTask.summary.slice(0,4000), updatedAt: message.workTask.updatedAt } : undefined,
    };
  };
  const summary = { id: original.id, title: original.title, projectId: null, mode: original.mode === 'bot' ? 'bot' as const : original.mode === 'code' ? 'code' as const : 'chat' as const, createdAt: original.createdAt, updatedAt: original.updatedAt };
  const view: ChatUpdate = {
    conversation: { ...summary, queuedRequests: original.queuedRequests?.slice(0, 20).map(item => ({ ...item, text: item.text.slice(0, 32000), images: undefined })), queuePaused: original.queuePaused, queueError: original.queueError?.slice(0, 300), messages: original.messages.slice(-200).map(projectMessage), sources: original.sources.filter(source=>original.messages.some(message=>message.attachmentIds?.includes(source.id))).slice(-64).map(source=>({id:source.id,conversationId:original.id,projectId:null,kind:source.kind,title:source.title.slice(0,180),url:null,mime:source.mime,size:source.size,createdAt:source.createdAt,messageId:source.messageId})), tools: work.tools.filter(tool => tool.conversationId === original.id).map(tool => remoteTool(tool,iconKeys[tool.name])) },
    library: { bot:personalBot ?? null, projects: [], notificationItems: update.library.notificationItems?.filter(item => libraryAccess ? update.library.conversations.some(chat => chat.id === item.conversationId && visibleConversation(chat)) : item.conversationId === original.id).slice(0, 50).map(item => ({ id: item.id, conversationId: item.conversationId, title: item.title.slice(0, 120), conversationTitle: item.conversationTitle.slice(0, 120), createdAt: item.createdAt, read: item.read })), conversations: libraryAccess ? update.library.conversations.filter(chat => visibleConversation(chat)).slice(0, 300).map(chat => ({ id: chat.id, title: chat.title.slice(0,120), projectId: null, mode: chat.mode, createdAt: chat.createdAt, updatedAt: chat.updatedAt, archived: chat.archived, pinned: chat.pinned })) : [summary], lastConversationId: original.id,
      activeRuns: update.library.activeRuns.filter(run => run.conversationId === original.id || libraryAccess && update.library.conversations.some(chat => chat.id === run.conversationId && visibleConversation(chat))).map(run => ({
        conversationId: run.conversationId, runId: run.runId, phase: run.phase, prose: run.prose?.slice(-2000), textLane: run.textLane, hasVisibleAnswer: run.hasVisibleAnswer,
      })), approvals: libraryAccess ? update.library.approvals.filter(item => item.conversationId === original.id && item.details.length <= 12000 && !item.imageModels?.length).slice(0,1).map(item => ({ id: item.id, conversationId: item.conversationId, runId: item.runId, name: item.name, summary: item.summary, details: item.details, prompt: item.prompt, pluginUse: item.pluginUse, onceOnly: true })) : [], browserHandoffs: [], browserTasks: [], workQuestions: libraryAccess ? update.library.workQuestions?.filter(item => item.conversationId === original.id && item.status === 'pending') : [] },
  };
  let budget = 550000;
  const messages = [] as typeof view.conversation.messages;
  for (const message of [...view.conversation.messages].reverse()) {
    const bytes = new TextEncoder().encode(JSON.stringify(message)).length;
    if (bytes > budget && messages.length) break;
    messages.unshift(message); budget -= bytes;
  }
  view.conversation.messages = messages;
  // Preserve recent versions within this authorized conversation. Large
  // histories keep their current path; the full graph remains on desktop.
  const retained = new Map(messages.map(message => [message.id, message]));
  let graphBytes = messages.reduce((size, message) => size + new TextEncoder().encode(JSON.stringify(message)).length, 0);
  if (graphBytes < 150000) {
    for (const message of original.allMessages ?? []) {
      if (retained.has(message.id) || retained.size >= 300 || message.parentId && !retained.has(message.parentId)) continue;
      const projected = projectMessage(message), bytes = new TextEncoder().encode(JSON.stringify(projected)).length;
      if (graphBytes + bytes > 150000) continue;
      retained.set(message.id, projected); graphBytes += bytes;
    }
    if (retained.size > messages.length) view.conversation.allMessages = [...(original.allMessages ?? original.messages)].filter(message => retained.has(message.id)).map(message => retained.get(message.id)!);
  }
  for (const message of view.conversation.allMessages ?? messages) if (!message.parentId || !retained.has(message.parentId)) message.parentId = null;
  view.conversation.headId = messages.at(-1)?.id ?? null;
  if (new TextEncoder().encode(JSON.stringify(view)).length > 800000) delete view.conversation.allMessages;
  while (new TextEncoder().encode(JSON.stringify(view)).length > 800000 && view.conversation.messages.length > 1) view.conversation.messages.shift();
  return view;
}
