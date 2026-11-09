import { z } from 'zod';

const base = { conversationId: z.uuid() };
const owned = { ...base, id: z.uuid() };
export const terminalRequestSchema = z.discriminatedUnion('action', [
  z.object({ ...base, action: z.literal('state') }).strict(),
  z.object({ ...base, action: z.literal('create') }).strict(),
  z.object({ ...owned, action: z.literal('write'), data: z.string().max(65536) }).strict(),
  z.object({ ...owned, action: z.literal('resize'), cols: z.number().int().min(10).max(500), rows: z.number().int().min(2).max(300) }).strict(),
  z.object({ ...owned, action: z.enum(['close', 'clear', 'use']) }).strict(),
]);
export type TerminalRequest = z.infer<typeof terminalRequestSchema>;
export interface WorkspaceTerminal {
  id: string; title: string; cwd: string; owner: 'agent' | 'user'; locked: boolean;
  busy: boolean; status: 'starting' | 'running' | 'idle' | 'exited' | 'interrupted';
  output: string; offset: number; revision: number;
}
export interface TerminalState { conversationId: string; terminals: WorkspaceTerminal[] }
export const TERMINAL_LOCKED = 'This terminal belongs to the agent until its reply finishes.';
export const TERMINAL_UNAVAILABLE = 'This terminal is no longer available. Open a new terminal.';
export const TERMINAL_START_ERROR = 'The terminal could not start. Open a new terminal to try again.';
