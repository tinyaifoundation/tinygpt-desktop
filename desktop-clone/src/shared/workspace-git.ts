import { z } from 'zod';

export const gitScopeSchema = z.enum(['working', 'staged', 'last-commit']);
export type GitScope = z.infer<typeof gitScopeSchema>;
export const workspaceGitRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('state'), conversationId: z.uuid(), scope: gitScopeSchema }).strict(),
  z.object({ action: z.literal('diff'), conversationId: z.uuid(), scope: gitScopeSchema, path: z.string().min(1).max(2048) }).strict(),
  z.object({ action: z.enum(['init', 'push']), conversationId: z.uuid() }).strict(),
  z.object({ action: z.enum(['stage', 'unstage']), conversationId: z.uuid(), path: z.string().min(1).max(2048) }).strict(),
  z.object({ action: z.literal('commit'), conversationId: z.uuid(), message: z.string().trim().min(1).max(2000) }).strict(),
]);
export type WorkspaceGitRequest = z.infer<typeof workspaceGitRequestSchema>;
export interface GitFileChange { path: string; previousPath?: string; status: 'new' | 'modified' | 'deleted' | 'renamed' | 'conflict'; additions: number; deletions: number; binary: boolean; staged: boolean; unstaged: boolean }
export interface WorkspaceGitState { initialized: boolean; branch: string; head: string | null; upstream: string | null; files: GitFileChange[]; scope: GitScope; parentRepository?: boolean }
export interface WorkspaceGitResult { state?: WorkspaceGitState; diff?: { path: string; before: string; after: string; binary: boolean } }
