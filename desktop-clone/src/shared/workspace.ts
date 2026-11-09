import { z } from 'zod';
import { pageUrlSchema } from './tools';
export interface BrowserTab { id: string; title: string; url: string; favicon: string; loading: boolean; error: string; canGoBack: boolean; canGoForward: boolean; zoom: number; tool: boolean }
export interface BrowserState { conversationId: string; tabs: BrowserTab[]; activeId: string | null }
export interface BrowserHistoryEntry { url: string; title: string; visitedAt: number }
export const browserRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('state'), conversationId: z.uuid() }).strict(),
  z.object({ action: z.literal('new'), conversationId: z.uuid(), url: pageUrlSchema.optional() }).strict(),
  z.object({ action: z.literal('navigate'), conversationId: z.uuid(), tabId: z.uuid(), url: pageUrlSchema }).strict(),
  z.object({ action: z.enum(['activate', 'close', 'back', 'forward', 'reload', 'stop', 'duplicate', 'save-source', 'print', 'screenshot', 'downloads']), conversationId: z.uuid(), tabId: z.uuid() }).strict(),
  z.object({ action: z.literal('zoom'), conversationId: z.uuid(), tabId: z.uuid(), value: z.number().min(50).max(300) }).strict(),
  z.object({ action: z.literal('find'), conversationId: z.uuid(), tabId: z.uuid(), query: z.string().max(500), forward: z.boolean().default(true) }).strict(),
]);
export type BrowserRequest = z.infer<typeof browserRequestSchema>;
export const browserLayoutSchema = z.object({ conversationId: z.uuid(), tabId: z.uuid().nullable(), bounds: z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().min(0).max(20000), height: z.number().finite().min(0).max(20000) }).strict().nullable(), cornerRadius: z.number().finite().min(0).max(100).optional(), rightInset: z.number().finite().min(0).max(64).optional() }).strict();
export type BrowserLayout = z.infer<typeof browserLayoutSchema>;
export const browserScrollRequestSchema = z.object({ conversationId: z.uuid(), tabId: z.uuid(), position: z.number().finite().min(0).max(1).optional() }).strict();
export type BrowserScrollRequest = z.infer<typeof browserScrollRequestSchema>;
export interface BrowserScroll { height: number; viewport: number; top: number }
export interface WorkspaceEntry { name: string; path: string; kind: 'directory' | 'file' | 'link'; size: number | null }
export interface FilePreview { id: string; name: string; path: string; kind: 'text' | 'image' | 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'binary'; mime: string; size: number; text?: string; bytesBase64?: string; sha256: string; writable: boolean }
export const workspaceFileRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('choose'), conversationId: z.uuid() }).strict(),
  z.object({ action: z.literal('list'), conversationId: z.uuid(), path: z.string().max(2048).default('.') }).strict(),
  z.object({ action: z.literal('find'), conversationId: z.uuid(), query: z.string().max(200) }).strict(),
  z.object({ action: z.literal('read'), conversationId: z.uuid(), path: z.string().min(1).max(2048), projectId: z.uuid().optional(), generated: z.boolean().optional() }).strict(),
  z.object({ action: z.enum(['create-file', 'create-folder']), conversationId: z.uuid(), path: z.string().min(1).max(2048) }).strict(),
  z.object({ action: z.enum(['reveal-entry', 'copy-path', 'copy-relative-path', 'cut', 'copy', 'delete']), conversationId: z.uuid(), path: z.string().min(1).max(2048) }).strict(),
  z.object({ action: z.literal('rename'), conversationId: z.uuid(), path: z.string().min(1).max(2048), name: z.string().min(1).max(200) }).strict(),
  z.object({ action: z.literal('paste'), conversationId: z.uuid(), path: z.string().min(1).max(2048) }).strict(),
  z.object({ action: z.literal('clipboard-state'), conversationId: z.uuid() }).strict(),
  z.object({ action: z.enum(['refresh', 'reveal', 'export', 'add-source']), conversationId: z.uuid(), id: z.uuid() }).strict(),
  z.object({ action: z.literal('save'), conversationId: z.uuid(), id: z.uuid(), text: z.string().max(500000), sha256: z.string().regex(/^[a-f\d]{64}$/) }).strict(),
]);
export type WorkspaceFileRequest = z.infer<typeof workspaceFileRequestSchema>;
export interface WorkspaceFileResult { files?: FilePreview[]; file?: FilePreview; entries?: WorkspaceEntry[]; truncated?: boolean; sourceId?: string; canPaste?: boolean; moved?: { from: string; to: string }; removedPath?: string; createdPath?: string }
