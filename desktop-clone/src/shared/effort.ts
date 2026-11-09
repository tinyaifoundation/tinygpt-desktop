import { z } from 'zod';
import { builtInModelId, builtInModels } from './managed-local';

export const effortLevels = ['instant', 'low', 'medium', 'high', 'max'] as const;
export const effortSchema = z.enum(effortLevels);
export type Effort = z.infer<typeof effortSchema>;
export const effortLabel = (effort: Effort) => effort[0].toUpperCase() + effort.slice(1);
export const nativeEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const nativeEffortSchema = z.enum(nativeEfforts);
export type NativeEffort = z.infer<typeof nativeEffortSchema>;
export const reasoningProfileSchema = z.object({
  kind: z.enum(['none', 'openai', 'openrouter', 'anthropic-adaptive', 'anthropic-budget', 'ollama', 'llamacpp']),
  efforts: z.array(nativeEffortSchema).max(7),
  canDisable: z.boolean(),
  tokenBudget: z.boolean().optional(),
  instantThinking: z.literal('between_tools').optional(),
}).strict();
export type ReasoningProfile = z.infer<typeof reasoningProfileSchema>;
export const modelCapabilitiesSchema = z.object({ model: z.string().max(300), name: z.string().max(300).optional(), images: z.boolean().optional(), reasoning: reasoningProfileSchema }).strict();
export type ModelInfo = { id: string; name?: string; contextWindowTokens?: number; maxOutputTokens?: number; reasoning?: ReasoningProfile; tools?: boolean; images?: boolean; free?: boolean; inputPrice?: number; outputPrice?: number };
export function modelDisplayName(model: Pick<ModelInfo, 'id' | 'name'>, openrouter = false): string {
  const builtIn = !openrouter && builtInModelId(model.id);
  if (builtIn) return builtInModels[builtIn].name;
  if (openrouter && model.id.replace(/:nitro$/, '') === 'openrouter/auto-beta') return 'Auto';
  const name = model.name?.trim();
  // Keep the catalog's spelling, versions and variant suffixes. OpenRouter
  // prefixes some display names with "Author: "; this is not part of the name.
  // IDs remain the honest fallback when the provider supplies no display name.
  return name ? openrouter ? name.replace(/^[^:]+:\s+(.+)$/, '$1').trim() : name : model.id;
}
export const EFFORT_BUDGET_MESSAGE = 'This model needs more output space for reasoning and an answer. Increase Maximum output tokens in Configuration, choose Instant if this model supports reasoning off, or select another model.';
