import type { Settings } from './config';
import type { ModelInfo } from './effort';

export const OPENROUTER_FREE_ROUTER = 'openrouter/free';
export const OPENROUTER_AUTO_ROUTER = 'openrouter/auto-beta';
export const costTierLabels: Record<Settings['openrouter']['costTier'], string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

export function autoRouterPlugin(model: string): 'auto-router' | 'auto-beta-router' | undefined {
  const id = model.replace(/:nitro$/, '');
  return id === 'openrouter/auto-beta' ? 'auto-beta-router' : id === 'openrouter/auto' ? 'auto-router' : undefined;
}
export function isOpenRouterRouter(model: string): boolean {
  return model.replace(/:nitro$/, '') === OPENROUTER_FREE_ROUTER || !!autoRouterPlugin(model);
}

// Virtual model slugs work even when a filtered catalog omits their entries.
// Capability fallbacks match OpenRouter's public router catalog; discovery can
// refresh them without delaying sign-in or requiring a manual model choice.
export function openRouterRouterInfo(id: string): ModelInfo {
  const free = id === OPENROUTER_FREE_ROUTER;
  return { id, name: free ? 'Free Models Router' : id === OPENROUTER_AUTO_ROUTER ? 'Auto Router (Beta)' : 'Auto Router', free, tools: true, images: true,
    contextWindowTokens: free ? 200000 : 2000000,
    reasoning: { kind: 'openrouter', efforts: ['none', 'low', 'medium', 'high'], canDisable: true } };
}
export function openRouterDefaultModel(access: Settings['openrouter']['access']): ModelInfo {
  return openRouterRouterInfo(access === 'free' ? OPENROUTER_FREE_ROUTER : OPENROUTER_AUTO_ROUTER);
}
export function withOpenRouterDefault(config: Settings['byok'], policy: Settings['openrouter']): Settings['byok'] {
  const model = openRouterDefaultModel(policy.access);
  return { ...config, model: model.id, tools: model.tools!, images: model.images!, contextWindowTokens: model.contextWindowTokens,
    maxOutputTokens: undefined, reasoningOverride: undefined,
    modelCapabilities: { model: model.id, name: model.name, images: model.images, reasoning: model.reasoning! } };
}
export function withOpenRouterRouters(models: ModelInfo[], access: Settings['openrouter']['access']): ModelInfo[] {
  const available = models.filter(model => access !== 'free' || !autoRouterPlugin(model.id));
  for (const id of access === 'free' ? [OPENROUTER_FREE_ROUTER] : [OPENROUTER_FREE_ROUTER, 'openrouter/auto', OPENROUTER_AUTO_ROUTER]) {
    if (!available.some(model => model.id === id)) available.push(openRouterRouterInfo(id));
  }
  const defaultId = openRouterDefaultModel(access).id;
  return available.sort((a, b) => Number(b.id === defaultId) - Number(a.id === defaultId));
}
