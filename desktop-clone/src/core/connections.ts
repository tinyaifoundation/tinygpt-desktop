import { endpointSchema, type InferenceRoute, type Settings } from '../shared/config';
import type { ConnectionReport } from '../shared/contracts';
import { z } from 'zod';
import { openRouterAttributionFetch } from './openrouter-attribution';
import { nativeEffortSchema, reasoningProfileSchema, type ModelInfo, type ReasoningProfile } from '../shared/effort';
import { reasoningProfile } from './effort';
import { autoRouterPlugin, withOpenRouterRouters } from '../shared/openrouter-routers';
import { isChatModel } from './chat-models';

const windowSchema = z.number().int().min(4096).max(2000000).optional().catch(undefined);
const catalogReasoningSchema = z.object({ supported_efforts: z.array(nativeEffortSchema).max(7).nullable().optional(), mandatory: z.boolean().optional(), supports_max_tokens: z.boolean().optional() });
const supportedSchema = z.object({ supported: z.boolean() });
const anthropicCapabilitiesSchema = z.object({
  thinking: z.object({ supported: z.boolean(), types: z.object({ adaptive: supportedSchema.optional(), enabled: supportedSchema.optional(), disabled: supportedSchema.optional(), between_tools: supportedSchema.optional() }) }),
  effort: z.object({ supported: z.boolean(), low: supportedSchema.optional(), medium: supportedSchema.optional(), high: supportedSchema.optional(), xhigh: supportedSchema.optional(), max: supportedSchema.optional() }).optional(),
});
const modelListSchema = z.object({ data: z.array(z.object({ id: z.string().max(200), name: z.string().max(300).optional(), context_length: windowSchema, context_window: windowSchema, max_model_len: windowSchema, max_input_tokens: windowSchema,
  input_modalities: z.array(z.string()).optional().catch(undefined), output_modalities: z.array(z.string()).optional().catch(undefined),
  type: z.string().optional().catch(undefined), task: z.string().optional().catch(undefined), aliases: z.array(z.string().max(200)).max(100).optional().catch(undefined),
  pricing: z.record(z.string(), z.string()).optional().catch(undefined),
  architecture: z.object({ input_modalities: z.array(z.string()).optional(), output_modalities: z.array(z.string()).optional() }).optional().catch(undefined),
  supported_parameters: z.array(z.string()).optional().catch(undefined),
  supports_tool_calling: z.boolean().optional().catch(undefined), supports_vision: z.boolean().optional().catch(undefined),
  top_provider: z.object({ max_completion_tokens: z.number().int().positive().nullable().optional() }).optional().catch(undefined),
  reasoning: catalogReasoningSchema.optional().catch(undefined), capabilities: anthropicCapabilitiesSchema.optional().catch(undefined), tinygpt_reasoning: reasoningProfileSchema.optional().catch(undefined) })).max(10000), has_more: z.boolean().optional(), last_id: z.string().min(1).max(200).optional() });

export function modelsUrl(endpoint: string): string {
  return `${endpointSchema.parse(endpoint).replace(/\/+$/, '')}/models`;
}

export async function checkConnection(
  settings: Settings,
  route: InferenceRoute,
  secret: string | undefined,
  request: typeof fetch = fetch,
): Promise<ConnectionReport> {
  if (route === 'portal') return {
    reachable: false, modelAvailable: false, models: [],
    message: 'Portal connection checks will be enabled with the TinyGPT backend.',
  };
  if (route === 'byok' && !secret) throw new Error('Add your provider API key first.');
  const config = settings[route];
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (route === 'byok' && settings.byok.protocol === 'anthropic') {
    headers['x-api-key'] = secret!;
    headers['anthropic-version'] = '2023-06-01';
  } else if (secret) headers.Authorization = `Bearer ${secret}`;
  const signal = AbortSignal.timeout(10000);
  const catalog: z.infer<typeof modelListSchema>['data'] = [];
  const cursors = new Set<string>();
  const openrouter = route === 'byok' && settings.byok.provider === 'openrouter';
  let url = modelsUrl(config.endpoint), bytes = 0;
  const xaiLanguage = route === 'byok' && settings.byok.provider === 'xai' && new URL(url).origin === 'https://api.x.ai';
  // xAI's language catalog excludes image/video generation and supplies modalities.
  if (xaiLanguage) url = url.replace(/\/models$/, '/language-models');
  const attributedRequest = openRouterAttributionFetch(request);
  if (openrouter) url += `?sort=most-popular${settings.openrouter.zeroDataRetention ? '&zdr=true' : ''}`;
  for (let page = 0; ; page++) {
    const response = await attributedRequest(url, { headers, signal, redirect: 'error' });
    // Do not expose upstream response bodies: they can contain credentials,
    // request echoes, internal addresses, or Portal model identities.
    if (!response.ok) throw new Error(
      response.status === 401 || response.status === 403
        ? 'The endpoint did not accept your credentials.'
        : `The endpoint returned HTTP ${response.status}.`,
    );
    if (!response.body) throw new Error('The endpoint did not return a compatible model list.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 2_000_000) {
          await reader.cancel();
          throw new Error('The model list is too large.');
        }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    const payload = Buffer.concat(chunks).toString('utf8');
    const decoded = JSON.parse(payload);
    const parsed = modelListSchema.safeParse(xaiLanguage ? { data: decoded?.models } : decoded);
    if (!parsed.success) throw new Error('The endpoint did not return a compatible model list.');
    catalog.push(...parsed.data.data.flatMap(item => xaiLanguage ? [item, ...(item.aliases ?? []).filter(id => id !== item.id).map(id => ({ ...item, id }))] : [item]));
    if (catalog.length > 10000 || page >= 99) throw new Error('The model list is too large.');
    if (route !== 'byok' || settings.byok.protocol !== 'anthropic' || !parsed.data.has_more) break;
    const cursor = parsed.data.last_id;
    if (!cursor || cursors.has(cursor)) throw new Error('The endpoint did not return a compatible model list.');
    cursors.add(cursor);
    // Construct a same-endpoint cursor; never follow an upstream supplied URL.
    url = `${modelsUrl(config.endpoint)}?after_id=${encodeURIComponent(cursor)}&limit=100`;
  }
  const unique = new Map(catalog.filter(item => isChatModel(item, route === 'byok' ? settings.byok.provider : 'local', route === 'byok' ? settings.byok.protocol : 'openai-compatible') && (!openrouter || settings.openrouter.access === 'paid' || !autoRouterPlugin(item.id) && isFreeModel(item))).map(item => [item.id, item]));
  let models = openrouter ? [...unique.keys()] : [...unique.keys()].sort();
  let modelDetails: ModelInfo[] = models.map(id => {
    const model = unique.get(id)!;
    const contextWindowTokens = model.context_length ?? model.context_window ?? model.max_model_len ?? model.max_input_tokens;
    let reasoning: ReasoningProfile | undefined;
    if (route === 'byok' && settings.byok.protocol === 'anthropic' && model.capabilities) {
      const { thinking, effort } = model.capabilities;
      const efforts = (['low', 'medium', 'high', 'xhigh', 'max'] as const).filter(level => effort?.[level]?.supported);
      reasoning = !thinking.supported ? { kind: 'none', efforts: [], canDisable: false } : {
        kind: thinking.types.adaptive?.supported ? 'anthropic-adaptive' : thinking.types.enabled?.supported ? 'anthropic-budget' : 'none',
        efforts, canDisable: thinking.types.disabled?.supported === true,
        ...(thinking.types.between_tools?.supported ? { instantThinking: 'between_tools' as const } : {}),
        tokenBudget: !thinking.types.adaptive?.supported && thinking.types.enabled?.supported === true,
      };
    } else if (openrouter && model.reasoning) {
      reasoning = { kind: 'openrouter', efforts: model.reasoning.supported_efforts === null ? ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] : model.reasoning.supported_efforts ?? [], canDisable: model.reasoning.mandatory !== true, tokenBudget: model.reasoning.supports_max_tokens };
    } else if (openrouter && model.supported_parameters) {
      reasoning = model.supported_parameters.some(param => ['reasoning', 'reasoning_effort'].includes(param)) ? { kind: 'openrouter', efforts: ['none', 'low', 'medium', 'high'], canDisable: true } : { kind: 'none', efforts: [], canDisable: false };
    } else if (model.tinygpt_reasoning && (route === 'local' || settings.byok.provider === 'custom')) {
      reasoning = model.tinygpt_reasoning;
    } else {
      reasoning = reasoningProfile({ provider: route === 'local' ? 'local' : settings.byok.provider, protocol: route === 'local' ? 'openai-compatible' : settings.byok.protocol, model: model.id });
    }
    const maxOutputTokens = model.top_provider?.max_completion_tokens;
    return { id: model.id, name: model.name, ...(contextWindowTokens ? { contextWindowTokens } : {}), reasoning,
      ...(model.supports_tool_calling !== undefined ? { tools: model.supports_tool_calling } : {}), ...(model.supports_vision !== undefined ? { images: model.supports_vision } : {}),
      ...(!openrouter && (model.input_modalities ?? model.architecture?.input_modalities) ? { images: (model.input_modalities ?? model.architecture?.input_modalities)!.includes('image') } : {}),
      ...(openrouter ? { free: !autoRouterPlugin(model.id) && isFreeModel(model), tools: model.supported_parameters?.includes('tools') ?? false, images: model.architecture?.input_modalities?.includes('image') ?? false,
        ...(maxOutputTokens && maxOutputTokens >= 128 ? { maxOutputTokens: Math.min(maxOutputTokens, 128000) } : {}),
        inputPrice: Number(model.pricing?.prompt), outputPrice: Number(model.pricing?.completion) } : {}),
    };
  });
  if (openrouter) { modelDetails = withOpenRouterRouters(modelDetails, settings.openrouter.access); models = modelDetails.map(item => item.id); }
  const modelAvailable = Boolean(config.model && models.includes(config.model));
  const modelContextWindowTokens = modelDetails.find(item => item.id === config.model)?.contextWindowTokens;
  return {
    reachable: true, modelAvailable, models,
    modelDetails,
    ...(modelContextWindowTokens ? { modelContextWindowTokens } : {}),
    message: !config.model ? 'Connected. Choose a model to continue.'
      : modelAvailable ? 'Connected. Your selected model is available.'
      : 'Connected, but the selected model was not in the model list.',
  };
}

export function isFreeModel(model: { pricing?: Record<string, string> }): boolean {
  const pricing = model.pricing;
  return !!pricing && pricing.prompt !== undefined && pricing.completion !== undefined && Object.values(pricing).every(value => value.trim().length > 0 && Number.isFinite(Number(value)) && Number(value) === 0);
}
