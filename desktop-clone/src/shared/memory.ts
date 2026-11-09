import { z } from 'zod';

export const embeddingModel = 'Xenova/bge-small-en-v1.5';
export const embeddingRevision = 'ea104dacec62c0de699686887e3f920caeb4f3e3';
export const profileNameSchema = z.object({ firstName: z.string().trim().max(60), lastName: z.string().trim().max(60) }).strict();
export type ProfileName = z.infer<typeof profileNameSchema>;
export const memoryInputSchema = z.object({ id: z.uuid().optional(), projectId: z.uuid().nullable(), title: z.string().trim().min(1).max(200), text: z.string().trim().min(1).max(12000), enabled: z.boolean().default(true) }).strict();
export type MemoryInput = z.infer<typeof memoryInputSchema>;
export interface SavedMemory { id: string; projectId: string | null; title: string; text: string; enabled: boolean; updatedAt: number }
export interface IndexedDocument { id: string; projectId: string; title: string; updatedAt: number; size: number; excluded: boolean }
export interface StoredEvidence { id: string; projectId: string | null; title: string; text: string; updatedAt: number }
export interface ProjectIndexStatus { projectId: string; enabled: boolean; rootPath: string | null; status: 'idle' | 'indexing' | 'ready' | 'paused' | 'error'; files: number; skipped: number; lastScan: number | null; message: string }
export interface MemorySnapshot {
  includePersonal: boolean;
  memories: SavedMemory[];
  indexes: ProjectIndexStatus[];
  documents: IndexedDocument[];
  semantic: { enabled: boolean; status: 'off' | 'loading' | 'ready' | 'error'; message: string; embedded: number; pending: number };
}
export const indexRequestSchema = z.object({ projectId: z.uuid(), action: z.enum(['enable', 'disable', 'refresh', 'forget']) }).strict();
export const memorySearchSchema = z.object({ projectId: z.uuid().nullable(), query: z.string().trim().min(1).max(500) }).strict();
