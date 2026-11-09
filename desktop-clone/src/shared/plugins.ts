import { z } from 'zod';
import { endpointSchema, modeSchema, approvalSchema } from './config';
import type { Mode } from './config';

const short = z.string().trim().min(1).max(120);
export const connectorKindSchema = z.enum(['github', 'google', 'gmail', 'gdrive', 'gcalendar', 'slack']);
export const suggestedConnectorSchema = z.enum(['github', 'gmail', 'gdrive', 'gcalendar', 'slack', 'notion', 'higgsfield', 'linear']);
export type SuggestedConnector = z.infer<typeof suggestedConnectorSchema>;
export type ConnectorKind = z.infer<typeof connectorKindSchema>;
export const skillPackagePathSchema = z.string().min(1).max(300).regex(/^[A-Za-z0-9_./ ()-]+$/).refine(path => !path.startsWith('/') && path.split('/').every(part => part && part !== '.' && part !== '..' && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), 'Skill files must stay inside their package.');
export const skillPackageFileSchema = z.object({ path: skillPackagePathSchema, repositoryPath: skillPackagePathSchema, sha: z.string().regex(/^[a-f0-9]{40}$/), size: z.number().int().min(0).max(1024 * 1024), kind: z.enum(['text', 'asset']) }).strict();
export const skillMakerSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9-]+$/).max(100), name: short, url: z.string().url(), avatarUrl: z.string().url() }).strict();
export const skillSourceSchema = z.object({ repository: z.string().regex(/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/).max(200), commit: z.string().regex(/^[a-f0-9]{40}$/), directory: skillPackagePathSchema, url: z.string().url().max(4096), license: z.enum(['MIT', 'Apache-2.0']), licenseUrl: z.string().url().max(4096), checkedAt: z.string().datetime(), pushedAt: z.string().datetime(), files: z.array(skillPackageFileSchema).min(1).max(256) }).strict().refine(value => new Set(value.files.map(file => file.path)).size === value.files.length && value.files.reduce((sum, file) => sum + file.size, 0) <= 4 * 1024 * 1024, 'Skill package exceeds its supported bounds.');
export const skillUpstreamSchema = z.object({ catalogId: z.string().regex(/^[a-z][a-z0-9-]{1,60}$/), maker: skillMakerSchema, source: skillSourceSchema, modified: z.boolean().default(false) }).strict();
export type SkillSource = z.infer<typeof skillSourceSchema>;
export type SkillPackageFile = z.infer<typeof skillPackageFileSchema>;
export const skillSchema = z.object({ name: short, description: z.string().min(1).max(4000), instructions: z.string().min(1).max(64000), references: z.record(z.string().max(200), z.string().max(32000)).default({}), license: z.string().max(1000).optional(), compatibility: z.string().max(500).optional(), publisher: z.string().max(120).optional(), sourceUrl: z.string().url().max(4096).optional(), example: z.string().max(1000).optional(), requirements: z.array(z.string().max(120)).max(12).optional(), upstream: skillUpstreamSchema.optional() }).strict();
export type PluginSkill = z.infer<typeof skillSchema>;
export const pluginServerSchema = z.discriminatedUnion('transport', [
  z.object({ transport: z.literal('stdio'), command: z.string().trim().min(1).max(4096), args: z.array(z.string().max(4096)).max(100).default([]), environment: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/)).max(40).default([]) }).strict(),
  z.object({ transport: z.literal('http'), endpoint: endpointSchema, auth: z.enum(['none', 'bearer', 'oauth']).default('none') }).strict(),
]);
export type PluginServer = z.infer<typeof pluginServerSchema>;
export const pluginManifestSchema = z.object({
  format: z.literal(1), id: z.string().regex(/^[a-z][a-z0-9-]{1,60}$/), name: short,
  version: z.string().regex(/^\d+\.\d+\.\d+$/), description: z.string().max(2000),
  kind: z.enum(['mcp', 'skill', 'bundle', 'connector', 'builtin']),
  modes: z.array(modeSchema).min(1).max(3).default(['chat', 'bot', 'code']),
  server: pluginServerSchema.optional(), connector: connectorKindSchema.optional(),
  skills: z.array(skillSchema).max(20).default([]), dependencies: z.array(z.string().max(200)).max(20).default([]),
}).strict().superRefine((value, ctx) => {
  if ((value.kind === 'mcp' && !value.server) || (value.kind === 'connector' && !value.connector) || (value.kind === 'skill' && !value.skills.length)) ctx.addIssue({ code: 'custom', message: 'Missing plugin contents.' });
  if (value.kind !== 'connector' && value.connector || !['mcp', 'bundle'].includes(value.kind) && value.server) ctx.addIssue({ code: 'custom', message: 'Unsupported plugin contents.' });
  if (new Set(value.modes).size !== value.modes.length || new Set(value.skills.map(skill => skill.name)).size !== value.skills.length) ctx.addIssue({ code: 'custom', message: 'Duplicate modes or skills.' });
});
export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export const pluginConfigSchema = z.object({ projectIds: z.array(z.uuid()).max(100).nullable(), enabled: z.boolean(), rules: z.record(z.string().max(200), approvalSchema).default({}), resources: z.array(z.object({ projectId: z.uuid(), uri: z.string().max(2048), title: z.string().max(200) }).strict()).max(100).default([]), skillInvocation: z.record(z.string(), z.enum(['automatic', 'manual'])).optional() }).strict();
export type PluginConfig = z.infer<typeof pluginConfigSchema>;
export interface PluginRecord { id: string; manifest: PluginManifest; config: PluginConfig; source: string; installedAt: number; updatedAt: number }
export interface ExtensionToolDefinition { name: `ext_${string}`; originalName: string; pluginId: string; label: string; description: string; schema: Record<string, unknown>; category: 'read' | 'write' | 'send' | 'execute' }
export interface PluginResource { uri: string; name: string; description?: string; mimeType?: string }
export interface PluginView extends PluginRecord { status: 'disabled' | 'disconnected' | 'connecting' | 'connected' | 'error'; message: string; tools: ExtensionToolDefinition[]; resources: PluginResource[]; prompts: { name: string; description?: string }[]; hasCredentials: boolean; trusted: boolean; account?: { name: string; email?: string }; oauthConfigured?: boolean; oauthReleaseStatus?: 'unconfigured' | 'testing' | 'review' | 'production'; deviceCode?: string }
export interface PluginSnapshot { entries: PluginView[] }
export const pluginSaveSchema = z.object({ id: z.uuid().optional(), manifest: pluginManifestSchema, config: pluginConfigSchema }).strict();
export const connectorOAuthSchema = z.object({ provider: z.enum(['google', 'github', 'slack']), clientId: z.string().min(1).max(500), clientSecret: z.string().max(1000).optional(), accessToken: z.string().max(12000).optional(), refreshToken: z.string().max(12000).optional(), expiresAt: z.number().optional(), scope: z.string().max(3000).optional() }).strict();
export const pluginCredentialsSchema = z.object({ bearer: z.string().min(1).max(12000).optional(), environment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/), z.string().max(12000)).optional(), connectorAuth: connectorOAuthSchema.optional() }).strict();
export type PluginCredentials = z.infer<typeof pluginCredentialsSchema>;
export const pluginSelectionSchema = z.object({ conversationId: z.uuid().nullable(), projectId: z.uuid().nullable(), ids: z.array(z.uuid()).max(100) }).strict();
export const connectionRequestSchema = z.object({ type: z.literal('plugin-connection-request'), connector: suggestedConnectorSchema, reason: z.string().min(1).max(300), status: z.enum(['pending', 'connected', 'dismissed']) }).strict();
export type ConnectionRequest = z.infer<typeof connectionRequestSchema>;
export const pluginUseSchema = z.object({ pluginId: z.uuid(), name: short, connector: suggestedConnectorSchema.optional() }).strict();
export type PluginUse = z.infer<typeof pluginUseSchema>;
export const pluginUseRequestSchema = pluginUseSchema.extend({ type: z.literal('plugin-use-request'), status: z.enum(['pending', 'approved', 'denied', 'cancelled']) }).strict();

export const skillDraftInputSchema = z.object({ markdown: z.string().min(1).max(128000), references: z.record(z.string().max(200), z.string().max(32000)).default({}), sourceUrl: z.string().url().max(4096).optional(), draftId: z.uuid().optional(), targetPluginId: z.uuid().optional(), modes: z.array(modeSchema).min(1).max(3).default(['chat', 'code', 'bot']) }).strict();
export type SkillDraftInput = z.infer<typeof skillDraftInputSchema>;
export const skillDraftSchema = z.object({ id: z.uuid(), conversationId: z.uuid().nullable(), projectId: z.uuid().nullable(), skill: skillSchema, modes: z.array(modeSchema).min(1).max(3), targetPluginId: z.uuid().optional(), targetUpdatedAt: z.number().optional(), createdAt: z.number(), installedPluginId: z.uuid().optional() }).strict();
export type SkillDraft = z.infer<typeof skillDraftSchema>;
export interface CatalogSkill { id: string; title: string; category: string; tags: string[]; rank: number; version: string; modes: Mode[]; invocation: 'automatic' | 'manual'; skill: Pick<PluginSkill, 'name' | 'description' | 'requirements' | 'compatibility'>; maker: z.infer<typeof skillMakerSchema>; popularity: { repositoryStars: number; checkedAt: string }; source: SkillSource }
export interface SkillHubSnapshot { catalog: CatalogSkill[]; drafts: SkillDraft[]; entries: PluginView[] }
