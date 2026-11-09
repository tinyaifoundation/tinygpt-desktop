import { z } from 'zod';
import type { Project } from './projects';
import type { InferenceRoute } from './config';
import type { CitationSource } from './citations';
import type { ApprovalRequest, BrowserHandoff, SourceSummary, ToolActivity, ToolRequest } from './tools';

export const idSchema = z.uuid();
export const createConversationSchema = z.object({ projectId: idSchema.nullable() }).strict();
export const sendMessageSchema = z.object({ conversationId: idSchema, text: z.string().trim().min(1).max(32000), attachmentIds: z.array(idSchema).max(8).default([]) }).strict();
export const queueActionSchema = z.discriminatedUnion('action', [
  z.object({ conversationId: idSchema, action: z.literal('remove'), id: idSchema }).strict(),
  z.object({ conversationId: idSchema, action: z.literal('steer'), id: idSchema }).strict(),
  z.object({ conversationId: idSchema, action: z.literal('reorder'), ids: z.array(idSchema).max(20) }).strict(),
  z.object({ conversationId: idSchema, action: z.literal('edit'), id: idSchema, replacement: z.object({ text: z.string().trim().min(1).max(32000), attachmentIds: z.array(idSchema).max(8) }).optional() }).strict(),
  z.object({ conversationId: idSchema, action: z.literal('resume') }).strict(),
]);
export type QueueAction = z.infer<typeof queueActionSchema>;
export interface QueuedRequest { id: string; text: string; attachmentIds: string[]; images?: string[]; createdAt: number; lane: 'queue' | 'steer' }
export interface RunSteering { pending(): QueuedRequest[]; subscribe(wake: () => void): () => void; consume(ids: string[]): QueuedRequest[] }
export const messageActionSchema = z.object({ conversationId: idSchema, messageId: idSchema }).strict();
export const editMessageSchema = messageActionSchema.extend({ text: z.string().trim().min(1).max(32000) }).strict();
export type TurnAction = { type: 'edit' | 'regenerate' | 'continue' | 'resume-plugin'; messageId: string };
export interface ContextCheckpoint { throughMessageId: string; text: string }
export interface ContextActivity { id: string; runId: string; status: 'running' | 'complete' | 'error' | 'interrupted'; createdAt: number }
export type ContextEvent =
  | { type: 'optimizing'; id: string }
  | { type: 'checkpoint'; id: string; checkpoint: ContextCheckpoint }
  | { type: 'optimized'; id: string }
  | { type: 'optimization-failed'; id: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number };
export const projectInputSchema = z.object({ name: z.string().trim().min(1).max(120), instructions: z.string().trim().max(12000), browserIsolated: z.boolean().default(false), folderChoiceId: idSchema.optional() }).strict();
export const updateProjectSchema = projectInputSchema.extend({ id: idSchema, folderChoiceId: idSchema.nullable().optional() }).strict();
export const projectOrganizeSchema = z.discriminatedUnion('action', [
  z.object({ id: idSchema, action: z.literal('favorite'), value: z.boolean() }).strict(),
  z.object({ id: idSchema, action: z.literal('archive-chats') }).strict(),
  z.object({ id: idSchema, action: z.literal('remove') }).strict(),
]);
export type ProjectOrganization = z.infer<typeof projectOrganizeSchema>;
export const conversationOrganizeSchema = z.discriminatedUnion('action', [
  z.object({ id: idSchema, action: z.literal('pin'), value: z.boolean() }).strict(),
  z.object({ id: idSchema, action: z.literal('archive'), value: z.boolean() }).strict(),
  z.object({ id: idSchema, action: z.literal('move'), projectId: idSchema.nullable() }).strict(),
]);
export type ConversationOrganization = z.infer<typeof conversationOrganizeSchema>;
export interface ProfileUsage {
  totalTokens: number | null; peakTokens: number | null; missingUsage: boolean;
  longestChat: number; currentStreak: number; longestStreak: number;
  conversationCount: number; responseCount: number; toolCalls: number;
  daily: { day: string; messages: number; responses: number; chats: number; tokens: number | null; tools: number }[];
  topTools: { name: string; count: number }[];
}
export interface ConversationUsage {
  totalTokens: number | null; missingUsage: boolean; tokensPerSecond: number | null;
  messages: number; responses: number; toolCalls: number;
}
export const renameConversationSchema = z.object({ id: idSchema, title: z.string().trim().min(1).max(120) }).strict();

export interface ChatProject extends Project { instructions: string; browserIsolated: boolean; favorite?: boolean }
export type MessageStatus = 'complete' | 'streaming' | 'cancelled' | 'error' | 'interrupted';
export const OUTPUT_LIMIT_MESSAGE = 'The model reached its output limit before finishing. This reply is incomplete. Recorded tool results and any partial answer are saved. Choose Continue to resume the task.';
export const MODEL_ANSWER_BOUNDARY_MESSAGE = 'The model could not produce a clean final answer. Its unfinished thinking was not shown as an answer. Your recorded tool results are preserved; retry the reply.';
export const TOOL_OUTPUT_LIMIT_MESSAGE = 'The model reached its output limit while preparing a tool call. That incomplete call was not executed. This reply is incomplete. Choose Continue to resume using the recorded results.';
export const COMPACTION_OUTPUT_LIMIT_MESSAGE = 'Conversation optimization reached the model’s output limit. Your conversation history and last valid checkpoint are preserved. Retry this reply; if it keeps happening, select another model in Settings.';
export function isOutputLimitMessage(message: string | null): boolean { return message === OUTPUT_LIMIT_MESSAGE || message === TOOL_OUTPUT_LIMIT_MESSAGE; }
export const TOOL_LOOP_MESSAGE = 'The task paused because the same action kept failing without progress. Completed work is saved. Check the tool result or change your instructions, then choose Continue.';
export interface ChatMessage {
  /** Bounded citation display data for remote views; never used as model input. */
  citations?: CitationSource[];
  reactions?: import('./bot-reactions').MessageReaction[];
  id: string;
  role: 'user' | 'assistant';
  text: string;
  reasoning?: string;
  workDurationMs?: number | null;
  status: MessageStatus;
  error: string | null;
  createdAt: number;
  runId: string | null;
  route: InferenceRoute;
  parentId?: string | null;
  attachmentIds?: string[];
  continuationOf?: string | null;
  workTask?: import('./work').WorkTask;
  workActivity?: WorkActivity[];
  presentations?: { toolId: string; offset: number }[];
}
// Presentation history only. These records never become harness input.
export interface WorkActivity {
  id: string;
  runId: string;
  kind: 'prose' | 'reasoning' | 'tool' | 'steering';
  text: string;
  toolId?: string;
  agentId?: string;
  messageId?: string;
  answer?: boolean;
  startedAt?: number;
  omittedCharacters?: number;
}
export interface ConversationSummary {
  scheduled?: boolean;
  mode?: 'chat' | 'code' | 'bot';
  id: string;
  projectId: string | null;
  title: string;
  summary?: string | null;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
  archived?: boolean;
  unread?: boolean;
  connectionPending?: boolean;
}
export interface Conversation extends ConversationSummary { queuedRequests?: QueuedRequest[]; queuePaused?: boolean; queueError?: string; messages: ChatMessage[]; allMessages?: ChatMessage[]; headId?: string | null; sources: SourceSummary[]; tools: ToolActivity[]; contextActivities?: ContextActivity[]; diagnostics?: import('./diagnostics').TraceStamp }
export interface ActiveRun {
  conversationId: string;
  runId: string;
  phase?: 'connecting' | 'thinking' | 'tool-input' | 'tool' | 'answer' | 'waiting' | 'prose' | 'optimizing';
  prose?: string;
  textLane?: TextLane;
  hasVisibleAnswer?: boolean;
  effort?: import('./effort').Effort;
}
export interface LibrarySnapshot {
  bot?: import('./bot-design').RemoteBotState | null;
  notificationItems?: { id: string; conversationId: string; title: string; conversationTitle: string; createdAt: number; read: boolean }[];
  outputsRevision?: number;
  projects: ChatProject[];
  conversations: ConversationSummary[];
  lastConversationId: string | null;
  activeRuns: ActiveRun[];
  approvals: ApprovalRequest[];
  workQuestions?: import('./work').WorkQuestion[];
  browserHandoffs: BrowserHandoff[];
  browserTasks?: { conversationId: string; tabId: string; title: string; url: string }[];
}
export interface ChatUpdate { conversation: Conversation; library: LibrarySnapshot }

// Secrets travel only between the main process and its private worker.
export interface ChatWorkerInput {
  openrouter?: import('./config').Settings['openrouter'];
  mode?: 'chat' | 'code' | 'bot';
  workTask?: import('./work').WorkTask;
  projectRoot?: string;
  conversationId?: string;
  replyMessageId?: string;
  workAncestorMessageIds?: string[];
  runId: string;
  route: 'byok' | 'local';
  endpoint: string;
  protocol: 'openai-compatible' | 'openai-responses' | 'anthropic';
  provider: string;
  model: string;
  effort?: import('./effort').Effort;
  reasoning?: import('./effort').ReasoningProfile;
  secret?: string;
  instructions: string;
  messages: { id?: string; role: 'user' | 'assistant'; text: string; images?: string[]; operations?: import('./work').WorkOperation[] }[];
  vision?: boolean;
  imageTools?: boolean;
  tools?: boolean;
  computer?: boolean;
  extensionTools?: import('./plugins').ExtensionToolDefinition[];
  loadedPluginTools?: string[];
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  checkpoint?: ContextCheckpoint;
  purpose?: 'summary' | 'metadata';
  outputSchema?: Record<string, unknown>;
  // Host-only identity of a private proactive Pi check; never accepted from the renderer.
  nativeSessionKey?: string;
  nativeSilent?: boolean;
}
export type ChatWorkerEvent =
  | { type: 'steering-consumed'; ids: string[] }
  | { type: 'measured'; counts: number[] }
  | { type: 'ready' }
  | { type: 'warmed'; model: string }
  | { type: 'trace'; event: import('./diagnostics').TraceEvent }
  | { type: 'activity'; activity: import('./chat-timeouts').ProviderActivity }
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'response'; event: ResponseEvent }
  | { type: 'context'; event: ContextEvent }
  | { type: 'complete' }
  | { type: 'tool-request'; request: ToolRequest }
  | { type: 'failed'; message: string };
export type TextLane = 'progress' | 'answer' | 'unclassified';
export type ResponseEvent = { type: 'start'; lane: TextLane } | { type: 'preparing-tool' } | { type: 'tool' } | { type: 'end' } | { type: 'bot-messages'; messages: string[]; complete?: boolean }
  | { type: 'ui-preview'; id: string; ui: Record<string, unknown> | null }
  | { type: 'work-part'; id: string; kind: 'prose' | 'reasoning'; text: string; startedAt?: number; omittedCharacters?: number; agentId?: string }
  | { type: 'work-complete'; answerPartIds: string[]; answerText?: string };
export interface ChatExecution {
  isSnoozed?(): boolean;
  memoryEnabled?(): boolean;
  approvals?(): import('./tools').ApprovalRequest[];
  run(input: ChatWorkerInput, signal: AbortSignal, onDelta: (text: string) => void, onTool?: (request: ToolRequest) => Promise<string>, onReasoning?: (text: string) => void, onResponse?: (event: ResponseEvent) => void, onContext?: (event: ContextEvent) => void, onTrace?: (event: import('./diagnostics').TraceEvent) => void, onNativeCode?: import('./code').NativeCodeCallback, steering?: RunSteering, workControl?: import('./work').WorkControl): Promise<void>;
}
