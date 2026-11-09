import { z } from 'zod';
import { endpointSchema } from './config';

export const projectSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(120),
  rootPath: z.string().min(1).max(4096).nullable(),
}).strict();
export type Project = z.infer<typeof projectSchema>;

// A project-specific source never becomes global merely because another mode
// is querying it. All modes use the same retrieval boundary.
export interface MemorySource {
  id: string;
  scope: { type: 'global' } | { type: 'project'; projectId: string };
  origin: 'conversation' | 'file' | 'connector' | 'explicit-memory';
  enabled: boolean;
  deleted: boolean;
}
export interface RetrievalContext {
  projectId: string | null;
  linkedProjectIds: readonly string[];
  includeGlobalMemory: boolean;
}

export const mcpConnectionSchema = z.discriminatedUnion('transport', [
  z.object({
    transport: z.literal('stdio'),
    command: z.string().min(1).max(4096),
    args: z.array(z.string().max(4096)).max(100),
    // Runtime environment values resolve from encrypted storage, not manifests.
    credentialRefs: z.record(z.string(), z.string()),
  }).strict(),
  z.object({
    transport: z.literal('http'),
    endpoint: endpointSchema,
    credentialRef: z.string().optional(),
  }).strict(),
]);
export type MCPConnection = z.infer<typeof mcpConnectionSchema>;
// Connection configuration is not permission to install or execute a server.
// The tool broker must authorize startup and calls separately.
