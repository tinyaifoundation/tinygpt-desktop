import { endpointSchema, type Settings } from '../shared/config';
import type { LocalDiscovery } from '../shared/contracts';
import type { ModelInfo } from '../shared/effort';
import { checkConnection } from './connections';
import { openRouterAttributionFetch } from './openrouter-attribution';
import { builtInModelId, builtInModelInfo } from '../shared/managed-local';

export async function boundedJson(url: string, options: RequestInit = {}, request: typeof fetch = fetch): Promise<any> {
  const response = await openRouterAttributionFetch(request)(url, { ...options, redirect: 'error' });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'This server requires an API key.' : `The server returned HTTP ${response.status}.`);
  if (!response.body) throw new Error('The server did not return model information.');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try { while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length; if (bytes > 2_000_000) { await reader.cancel(); throw new Error('The model information is too large.'); } chunks.push(chunk.value); } }
  finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const capacity = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 4096 && value <= 2000000 ? value : undefined;
export function localEndpoint(value: string): string {
  const endpoint = endpointSchema.parse(value).replace(/\/+$/, '');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint).hostname)) throw new Error('Local discovery only connects to this computer.');
  return endpoint;
}

export async function inspectLocal(settings: Settings, endpoint: string, secret?: string, request: typeof fetch = fetch): Promise<LocalDiscovery['connections'][number]> {
  endpoint = localEndpoint(endpoint);
  const origin = new URL(endpoint).origin;
  const headers: Record<string, string> = secret ? { Authorization: `Bearer ${secret}` } : {};
  const deadline = AbortSignal.timeout(6000);
  const json = (path: string, body?: unknown) => boundedJson(origin + path, { headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, signal: AbortSignal.any([deadline, AbortSignal.timeout(1800)]), ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) }, request);
  const report = await checkConnection({ ...settings, local: { ...settings.local, endpoint, model: '' } }, 'local', secret, (resource, options) => request(resource, { ...options, signal: AbortSignal.any([deadline, AbortSignal.timeout(1800)]) })).catch(error => {
    if (error instanceof Error && error.message.includes('credentials')) throw new Error('This server requires an API key.');
    throw error;
  });
  let name = 'Compatible server'; let models = report.modelDetails ?? [];
  // Native metadata distinguishes installed models from loaded ones, excludes
  // embeddings, and reports the actual running context rather than guessing.
  const [ollama, lmstudio, props] = await Promise.allSettled([json('/api/tags'), json('/api/v1/models'), json('/props')]);
  if (ollama.status === 'fulfilled' && Array.isArray(ollama.value.models)) {
    name = 'Ollama';
    const ps = await json('/api/ps').catch(() => ({ models: [] }));
    const detailed = await Promise.allSettled(models.slice(0, 64).map(async model => {
      const info = await json('/api/show', { model: model.id });
      const capabilities: string[] = Array.isArray(info.capabilities) ? info.capabilities : [];
      if (capabilities.length && !capabilities.includes('completion')) return null;
      const running = Array.isArray(ps.models) ? ps.models.find((item: any) => item.name === model.id || item.model === model.id) : undefined;
      const configured = typeof info.parameters === 'string' ? Number(/(?:^|\n)num_ctx\s+(\d+)/.exec(info.parameters)?.[1]) : undefined;
      // Ollama's advertised trained context is not its configured runtime context.
      const contextWindowTokens = capacity(running?.context_length) ?? capacity(configured);
      return { ...model, tools: capabilities.includes('tools'), images: capabilities.includes('vision'), contextWindowTokens,
        reasoning: capabilities.includes('thinking') ? { kind: 'ollama' as const, efforts: [], canDisable: true } : model.reasoning };
    }));
    models = detailed.flatMap<ModelInfo>((result, index) => result.status === 'fulfilled' ? result.value ? [result.value] : [] : [{ ...models[index], tools: false, images: false }]);
  } else if (lmstudio.status === 'fulfilled' && Array.isArray(lmstudio.value.models)) {
    name = 'LM Studio';
    models = lmstudio.value.models.filter((item: any) => item.type === 'llm').flatMap((item: any): ModelInfo[] => {
      if (typeof item.key !== 'string' || !report.models.includes(item.key)) return [];
      const instance = item.loaded_instances?.[0];
      return [{ id: item.key, name: typeof item.display_name === 'string' ? item.display_name : item.key,
        contextWindowTokens: capacity(instance?.config?.context_length), tools: item.capabilities?.trained_for_tool_use === true, images: item.capabilities?.vision === true,
        reasoning: models.find(model => model.id === item.key)?.reasoning }];
    });
  } else if (props.status === 'fulfilled' && props.value.default_generation_settings) {
    name = 'llama.cpp';
    const contextWindowTokens = capacity(props.value.default_generation_settings.n_ctx);
    models = models.map(model => ({ ...model, contextWindowTokens: contextWindowTokens ?? model.contextWindowTokens,
      tools: props.value.chat_template_caps?.supports_tools === true && props.value.chat_template_caps?.supports_tool_calls === true || model.tools === true,
      images: props.value.modalities?.vision === true,
      ...(builtInModelId(model.id) && contextWindowTokens === 65536 ? (() => { const { id: _id, ...info } = builtInModelInfo(builtInModelId(model.id)!); return info; })() : {}) }));
  }
  return { endpoint, name, models: models.map(model => ({ ...model, tools: model.tools ?? false, images: model.images ?? false })) };
}

export async function discoverLocal(settings: Settings, endpoints: string[], secret?: string, request: typeof fetch = fetch, secretAt?: (endpoint: string) => string | undefined): Promise<LocalDiscovery> {
  const connections: LocalDiscovery['connections'] = [], unavailable: LocalDiscovery['unavailable'] = [];
  const candidates = [...new Set(endpoints.map(localEndpoint))].slice(0, 40);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(6, candidates.length) }, async () => {
    while (cursor < candidates.length) {
      const endpoint = candidates[cursor++];
      try { connections.push(await inspectLocal(settings, endpoint, secretAt ? secretAt(endpoint) : endpoint === settings.local.endpoint ? secret : undefined, request)); }
      catch (error) { if (error instanceof Error && error.message.includes('requires an API key')) unavailable.push({ endpoint, message: error.message }); }
    }
  }));
  connections.sort((a, b) => a.endpoint.localeCompare(b.endpoint));
  return { connections, unavailable };
}

export function withModel(settings: Settings, route: 'byok' | 'local', model: ModelInfo, endpoint = settings[route].endpoint): Settings {
  return { ...settings, route, [route]: { ...settings[route], endpoint, model: model.id, tools: model.tools ?? false, images: model.images ?? false,
    contextWindowTokens: model.contextWindowTokens, maxOutputTokens: model.maxOutputTokens ? Math.min(model.maxOutputTokens, 16384) : undefined,
    reasoningOverride: undefined, modelCapabilities: model.reasoning ? { model: model.id, name: model.name, images: model.images, reasoning: model.reasoning } : undefined } };
}

