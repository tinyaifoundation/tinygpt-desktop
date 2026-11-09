import { z } from 'zod';
import { imageSelectionSchema } from './image-generation';
import { effortSchema, modelCapabilitiesSchema, reasoningProfileSchema } from './effort';
import { notificationPreferencesSchema } from './notifications';
import { voicePreferencesSchema } from './voice';
import { computerPreferencesSchema } from './computer';

export const modeSchema = z.enum(['chat', 'bot', 'code']);
export const routeSchema = z.enum(['portal', 'byok', 'local']);
export type Mode = z.infer<typeof modeSchema>;
export type InferenceRoute = z.infer<typeof routeSchema>;
export const openRouterCostTiers = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

// No URL query or embedded credentials: secrets belong in the main-process vault.
export const endpointSchema = z.string().trim().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return !url.username && !url.password && !url.search && !url.hash
      && (url.protocol === 'https:' || (url.protocol === 'http:' && loopback));
  } catch { return false; }
}, 'Use HTTPS, or HTTP on localhost; keep credentials out of the URL.');

const modelSchema = z.string().trim().max(200);
export const approvalSchema = z.enum(['allow', 'ask', 'deny']);
export type ApprovalRule = z.infer<typeof approvalSchema>;
export const toolPermissionsSchema = z.object({
  read: approvalSchema.default('allow'),
  write: approvalSchema.default('ask'),
  execute: approvalSchema.default('ask'),
  browser: approvalSchema.default('ask'),
  interact: approvalSchema.default('ask'),
  desktop: approvalSchema.default('ask'),
  desktopInteract: approvalSchema.default('ask'),
  send: approvalSchema.default('ask'),
  purchase: approvalSchema.default('ask'),
}).strict();
export type ToolPermissions = z.infer<typeof toolPermissionsSchema>;
export const defaultToolPermissions: ToolPermissions = {
  read: 'allow', write: 'ask', execute: 'ask', browser: 'ask', interact: 'ask', desktop: 'ask', desktopInteract: 'ask', send: 'ask', purchase: 'ask',
};
export const browserPreferencesSchema = z.object({
  engine: z.enum(['google', 'bing', 'brave', 'duckduckgo']).default('duckduckgo'),
  adBlock: z.boolean().default(true),
  showFullUrl: z.boolean().default(false),
  webLinkDestination: z.enum(['workspace', 'system']).default('workspace'),
  localLinkDestination: z.enum(['workspace', 'system']).default('workspace'),
}).strict();
export type BrowserPreferences = z.infer<typeof browserPreferencesSchema>;
export const settingsSchema = z.object({
  version: z.literal(1),
  modelResidency: z.object({ keepLoaded: z.boolean().default(false), idleMinutes: z.number().int().min(1).max(120).default(10) }).strict().optional(),
  imageGeneration: imageSelectionSchema.optional(),
  voice: voicePreferencesSchema.default(voicePreferencesSchema.parse({})),
  computer: computerPreferencesSchema.default(computerPreferencesSchema.parse({})),
  builtIn: z.object({ proMtp: z.boolean().default(true) }).strict().default({ proMtp: true }),
  mode: modeSchema,
  route: routeSchema,
  openrouter: z.object({
    access: z.enum(['free', 'paid']).default('free'),
    nitro: z.boolean().default(false),
    zeroDataRetention: z.boolean().default(false),
    allowDataCollection: z.boolean().default(false),
    costTier: z.enum(openRouterCostTiers).default('low'),
  }).strict().default({ access: 'free', nitro: false, zeroDataRetention: false, allowDataCollection: false, costTier: 'low' }),
  effort: z.object({ chat: effortSchema.default('medium'), code: effortSchema.default('medium') }).strict().default({ chat: 'medium', code: 'medium' }),
  portal: z.object({ endpoint: z.union([z.literal(''), endpointSchema]) }).strict(),
  byok: z.object({
    provider: z.enum(['openai', 'anthropic', 'xai', 'openrouter', 'custom']),
    protocol: z.enum(['openai-compatible', 'openai-responses', 'anthropic']),
    endpoint: endpointSchema,
    model: modelSchema,
    tools: z.boolean().default(true),
    images: z.boolean().default(false),
    contextWindowTokens: z.number().int().min(4096).max(2000000).optional(),
    maxOutputTokens: z.number().int().min(128).max(128000).optional(),
    modelCapabilities: modelCapabilitiesSchema.optional(),
    reasoningOverride: reasoningProfileSchema.optional(),
  }).strict(),
  local: z.object({ endpoint: endpointSchema, model: modelSchema, tools: z.boolean().default(false), images: z.boolean().default(false), contextWindowTokens: z.number().int().min(4096).max(2000000).optional(), maxOutputTokens: z.number().int().min(128).max(128000).optional(), modelCapabilities: modelCapabilitiesSchema.optional(), reasoningOverride: reasoningProfileSchema.optional() }).strict(),
  browser: browserPreferencesSchema.default(browserPreferencesSchema.parse({})),
  notifications: notificationPreferencesSchema.default(notificationPreferencesSchema.parse({})),
  toolPermissions: toolPermissionsSchema.default(defaultToolPermissions),
}).strict();
export type Settings = z.infer<typeof settingsSchema>;

export const defaultSettings: Settings = {
  version: 1, mode: 'chat', route: 'local',
  voice: voicePreferencesSchema.parse({}),
  computer: computerPreferencesSchema.parse({}),
  builtIn: { proMtp: true },
  openrouter: { access: 'free', nitro: false, zeroDataRetention: false, allowDataCollection: false, costTier: 'low' },
  effort: { chat: 'medium', code: 'medium' },
  portal: { endpoint: '' },
  byok: { provider: 'openai', protocol: 'openai-responses', endpoint: 'https://api.openai.com/v1', model: '', tools: true, images: false },
  local: { endpoint: 'http://127.0.0.1:11434/v1', model: '', tools: false, images: false },
  browser: browserPreferencesSchema.parse({}),
  notifications: notificationPreferencesSchema.parse({}),
  toolPermissions: { ...defaultToolPermissions },
};

export const secretSlotSchema = z.enum(['byok', 'local', 'portal']);
export type SecretSlot = z.infer<typeof secretSlotSchema>;
export const secretInputSchema = z.object({ slot: secretSlotSchema, value: z.string().trim().min(1).max(8192) }).strict();
export const providerPresets = {
  openai: { endpoint: 'https://api.openai.com/v1', protocol: 'openai-responses' },
  anthropic: { endpoint: 'https://api.anthropic.com/v1', protocol: 'anthropic' },
  xai: { endpoint: 'https://api.x.ai/v1', protocol: 'openai-compatible' },
  openrouter: { endpoint: 'https://openrouter.ai/api/v1', protocol: 'openai-compatible' },
  custom: { endpoint: 'https://your-provider.example/v1', protocol: 'openai-compatible' },
} as const;
