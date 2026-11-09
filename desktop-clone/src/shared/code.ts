export interface CodeChange {
  id: string; conversationId: string; runId: string; projectId: string | null; path: string;
  before: string | null; after: string; createdAt: number; reverted: boolean;
  state?: 'pending' | 'applied' | 'undo-pending' | 'reverted' | 'failed' | 'conflict';
}
export const CODE_RUNTIME_ERROR = 'The Work runtime could not start or stopped unexpectedly. Your conversation and completed changes are saved. Retry this reply.';
export const CODE_FOLDER_ERROR = 'Choose a Project with a folder before using Work.';

export type NativeCodeEvent =
  | { phase: 'before'; id: string; name: import('./tools').NativeCodeToolName; args: Record<string, unknown>; displayText?: string; approvalText?: string; agentId?: string }
  | { phase: 'output'; id: string; output: string }
  | { phase: 'after'; id: string; status: 'success' | 'error'; output: string; metadata?: Record<string, unknown> };
export type NativeCodeCallback = (event: NativeCodeEvent) => Promise<{ output?: string }>;
