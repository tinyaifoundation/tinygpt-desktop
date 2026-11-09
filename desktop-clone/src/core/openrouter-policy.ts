import type { Settings } from '../shared/config';
import { openRouterAttributionFetch } from './openrouter-attribution';
import { autoRouterPlugin, isOpenRouterRouter } from '../shared/openrouter-routers';

type Connection = { provider: string; protocol: string; model: string; openrouter?: Settings['openrouter'] };
/** Applied at every inference boundary, including summaries and metadata. */
export function openRouterPayload(payload: Record<string, unknown>, input: Connection): Record<string, unknown> {
  if (input.provider !== 'openrouter' || input.protocol !== 'openai-compatible' || !input.openrouter) return payload;
  const policy = input.openrouter;
  // Free mode cannot inherit SDK fallback models or paid routing variants.
  const nitroVariant = policy.nitro && policy.access === 'paid' && !input.model.endsWith(':free') && !isOpenRouterRouter(input.model);
  const result = { ...payload, model: nitroVariant ? `${input.model.replace(/:nitro$/, '')}:nitro` : input.model.replace(/:nitro$/, '') };
  delete (result as Record<string, unknown>).models;
  const plugins = Array.isArray(payload.plugins) ? payload.plugins.filter(plugin => !plugin || typeof plugin !== 'object' || !['auto-router', 'auto-beta-router'].includes(plugin.id)) : [];
  const pluginId = policy.access === 'paid' ? autoRouterPlugin(input.model) : undefined;
  if (pluginId) {
    const previous = Array.isArray(payload.plugins) ? payload.plugins.find(plugin => plugin && typeof plugin === 'object' && plugin.id === pluginId) : undefined;
    const { cost_quality_tradeoff: _deprecated, costTier: _sdkTier, ...options } = previous ?? {};
    plugins.push({ ...options, id: pluginId, cost_tier: policy.costTier ?? 'low' });
  }
  if (plugins.length) (result as Record<string, unknown>).plugins = plugins;
  else delete (result as Record<string, unknown>).plugins;
  (result as Record<string, unknown>).provider = {
    ...(policy.nitro && !nitroVariant ? { sort: 'throughput' } : {}),
    ...(policy.access === 'free' ? { max_price: { prompt: 0, completion: 0, request: 0, image: 0 } } : {}),
    zdr: policy.zeroDataRetention, data_collection: policy.allowDataCollection ? 'allow' : 'deny',
  };
  return result;
}

export function openRouterPolicyFetch(request: typeof fetch, input: Connection): typeof fetch {
  const attributedRequest = openRouterAttributionFetch(request);
  return async (resource, options) => {
    if (input.provider !== 'openrouter' || typeof options?.body !== 'string') return attributedRequest(resource, options);
    return attributedRequest(resource, { ...options, body: JSON.stringify(openRouterPayload(JSON.parse(options.body), input)) });
  };
}
