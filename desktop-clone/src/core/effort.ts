import { effortLevels, nativeEfforts, EFFORT_BUDGET_MESSAGE, type Effort, type NativeEffort, type ReasoningProfile } from '../shared/effort';

type Connection = { provider: string; model: string; protocol: string; reasoning?: ReasoningProfile };
const standard: NativeEffort[] = ['low', 'medium', 'high'];
const noNative: ReasoningProfile = { kind: 'none', efforts: [], canDisable: false };

// Catalog declarations take precedence. These conservative fallbacks only cover
// documented model families on their actual provider; a compatible API alone
// is not evidence that its models accept reasoning parameters.
export function reasoningProfile(input: Connection): ReasoningProfile {
  if (input.reasoning) {
    const anthropic = input.reasoning.kind.startsWith('anthropic-');
    if (input.reasoning.kind !== 'none' && (anthropic !== (input.protocol === 'anthropic') || ['ollama', 'llamacpp'].includes(input.reasoning.kind) && input.protocol !== 'openai-compatible')) return noNative;
    return input.reasoning;
  }
  const model = input.model.replace(/^(openai|anthropic|x-ai)\//, '');
  if (input.provider === 'openai') {
    if (input.protocol === 'anthropic') return noNative;
    if (/^gpt-6\.1-sol(?:-|$)/.test(model)) return { kind: 'openai', efforts: [...standard, 'xhigh', 'max'], canDisable: false };
    if (/^gpt-6-astra(?:-|$)/.test(model)) return { kind: 'openai', efforts: [...standard, 'xhigh', 'max'], canDisable: false };
    if (/^gpt-(?:6-(?:sol|luna)|5\.6(?:-(?:sol|terra|luna))?)(?:-\d{4}-\d{2}-\d{2})?$/.test(model)) return { kind: 'openai', efforts: ['none', ...standard, 'xhigh', 'max'], canDisable: true };
    if (/^gpt-5\.1(?:-\d{4}-\d{2}-\d{2})?$/.test(model)) return { kind: 'openai', efforts: ['none', ...standard], canDisable: true };
    if (/^gpt-5\.(?:2|4|5)(?:-\d{4}-\d{2}-\d{2})?$/.test(model)) return { kind: 'openai', efforts: ['none', ...standard, 'xhigh'], canDisable: true };
    if (/^gpt-5(?:-mini|-nano)?(?:-\d{4}-\d{2}-\d{2})?$/.test(model)) return { kind: 'openai', efforts: ['minimal', ...standard], canDisable: false };
    if (/^(?:o1|o3|o3-mini|o4-mini)(?:-\d{4}-\d{2}-\d{2})?$/.test(model)) return { kind: 'openai', efforts: standard, canDisable: false };
  }
  if (input.provider === 'anthropic' && input.protocol === 'anthropic') {
    if (/^claude-(?:fable|mythos)-5(?:-|$)|^claude-opus-5-5(?:-|$)|^claude-mythos-preview(?:-|$)/.test(model)) return { kind: 'anthropic-adaptive', efforts: [...standard, 'xhigh', 'max'], canDisable: false };
    if (/^claude-sonnet-5-5(?:-|$)/.test(model)) return { kind: 'anthropic-adaptive', efforts: [...standard, 'xhigh', 'max'], canDisable: false, instantThinking: 'between_tools' };
    if (/^claude-(?:opus|sonnet|haiku)-5(?:-|$)/.test(model)) return { kind: 'anthropic-adaptive', efforts: [...standard, 'xhigh', 'max'], canDisable: true };
    if (/^claude-(?:opus|sonnet)-(?:4-[6-8]|4\.[6-8])(?:-|$)/.test(model)) return { kind: 'anthropic-adaptive', efforts: [...standard, ...(model.includes('opus') ? ['max' as const] : [])], canDisable: true };
    if (/^claude-(?:sonnet-4|opus-4|haiku-4-5|3-7-sonnet)(?:-|$)/.test(model)) return { kind: 'anthropic-budget', efforts: standard, canDisable: true, tokenBudget: true };
  }
  if (input.provider === 'xai' && /^grok-4\.[567](?:-|$)/.test(model)) return { kind: 'openai', efforts: [...standard, ...(/^grok-4\.[67]/.test(model) ? ['xhigh' as const] : [])], canDisable: false };
  // Keep the already supported Work model usable before catalog discovery.
  if (input.provider === 'openrouter' && input.model === 'z-ai/glm-5.3-flash') return { kind: 'openrouter', efforts: standard, canDisable: false };
  return noNative;
}

export function resolveEffort(effort: Effort, profile: ReasoningProfile): NativeEffort | undefined {
  const offered = nativeEfforts.filter(value => profile.efforts.includes(value) && (profile.canDisable || value !== 'none'));
  if (effort === 'instant') {
    if (profile.canDisable) return 'none';
    return offered[0];
  }
  const enabled = offered.filter(value => value !== 'none');
  if (!enabled.length) return undefined;
  if (effort === 'max') return enabled.at(-1);
  if (enabled.includes(effort)) return effort;
  const position = (effortLevels.indexOf(effort) - 1) / 3;
  return enabled[Math.round(position * (enabled.length - 1))];
}

export function effortInstructions(effort: Effort): string {
  return {
    instant: 'Prioritize a quick, direct response. Use tools when necessary, then return the verified answer. Do not add a generic acknowledgment or preamble. Do not skip needed evidence or required approvals.',
    low: 'Use a focused approach and respond concisely. Use tools when needed for accuracy or to carry out the task.',
    medium: 'Balance responsiveness with careful work. Gather the evidence needed to answer accurately and complete the requested task.',
    high: 'Work carefully on the requested task. Check important assumptions and verify results with the available evidence and tools.',
    max: 'Use your strongest supported effort on the requested task. Investigate difficult details and verify important results. Keep the final answer relevant; do not add unrelated work.',
  }[effort];
}

function budget(effort: Effort, outputTokens: number, minimumTokens = 1024): number | undefined {
  // Preserve a useful answer/tool budget; never silently increase a user's cap.
  const available = Math.floor(outputTokens * .6);
  if (available < minimumTokens) return undefined;
  const target = { instant: 0, low: 1024, medium: 2048, high: 4096, max: 8192 }[effort];
  return Math.max(minimumTokens, Math.min(target, available));
}

/** Shared by Chat's request transport and Work's authenticated provider gateway. */
export function effortPayload(payload: Record<string, unknown>, input: Connection & { effort?: Effort }, outputTokens: number): Record<string, unknown> {
  if (!input.effort) return payload;
  const profile = reasoningProfile(input);
  const resolved = resolveEffort(input.effort, profile);
  if (profile.kind === 'none') return payload;
  const result = { ...payload };
  for (const field of ['max_tokens', 'max_completion_tokens', 'max_output_tokens']) if (typeof payload[field] === 'number') outputTokens = Math.min(outputTokens, payload[field] as number);
  // The controller owns reasoning options. Never combine incompatible controls
  // supplied by an SDK with the selected adapter's controls.
  delete result.reasoning; delete result.reasoning_effort; delete result.thinking;
  if (profile.kind === 'anthropic-budget') {
    const tokens = budget(input.effort, outputTokens);
    if (resolved !== 'none' && !tokens) throw new Error(EFFORT_BUDGET_MESSAGE);
    result.thinking = resolved === 'none' ? { type: 'disabled' } : { type: 'enabled', budget_tokens: tokens };
    if (resolved !== 'none') { delete result.temperature; delete result.top_p; delete result.top_k; }
  } else if (profile.kind === 'anthropic-adaptive') {
    result.thinking = resolved === 'none' ? { type: 'disabled' } : { type: input.effort === 'instant' && profile.instantThinking ? profile.instantThinking : 'adaptive' };
    if (resolved && resolved !== 'none') result.output_config = { ...(result.output_config as object ?? {}), effort: resolved };
    else if (result.output_config && typeof result.output_config === 'object') { const output = { ...result.output_config }; delete (output as Record<string, unknown>).effort; result.output_config = output; }
  } else if (profile.kind === 'openrouter') {
    const tokens = budget(input.effort, outputTokens);
    if (resolved === 'none') result.reasoning = { enabled: false, effort: 'none' };
    else if (profile.tokenBudget && !profile.efforts.length) { if (!tokens) throw new Error(EFFORT_BUDGET_MESSAGE); result.reasoning = { enabled: true, max_tokens: tokens }; }
    else if (resolved) result.reasoning = { effort: resolved };
    else if (profile.canDisable) result.reasoning = { enabled: true };
  } else if (profile.kind === 'llamacpp') {
    if (resolved) { result.reasoning_effort = resolved; result.chat_template_kwargs = { ...(result.chat_template_kwargs as object ?? {}), enable_thinking: resolved !== 'none' }; }
    // A forced thinking cutoff can expose unfinished reasoning in the content
    // channel (notably MiniCPM). Use native effort/disable controls and the total
    // output cap, without forcing a transition into an answer mid-thought.
    delete result.thinking_budget_tokens;
    delete result.reasoning_budget_tokens;
    if (resolved === 'none') result.reasoning_budget_tokens = 0;
  } else if (resolved) {
    if (input.protocol === 'openai-responses') result.reasoning = { effort: resolved };
    else result.reasoning_effort = resolved;
  }
  if (profile.kind === 'openai' && input.provider === 'openai' && resolved && resolved !== 'none') {
    for (const field of ['temperature', 'top_p', 'top_logprobs', 'logprobs']) delete result[field];
  }
  if (input.provider === 'xai') {
    for (const field of ['presence_penalty', 'frequency_penalty', 'stop']) delete result[field];
  }
  return result;
}

export function effortFetch(request: typeof fetch, input: Connection & { effort?: Effort; purpose?: string }, outputTokens: number, internalRequest: () => boolean = () => false, onBudgetFailure: () => void = () => {}): typeof fetch {
  return async (resource, options) => {
    // Local sidebar metadata has a small, independent answer budget. Supported
    // models should spend it on the title/summary JSON, not hidden reasoning.
    if ((input.purpose === 'metadata' || input.purpose === 'summary' || internalRequest()) && input.provider === 'local' && reasoningProfile(input).canDisable && typeof options?.body === 'string') {
      const payload = JSON.parse(options.body) as Record<string, unknown>;
      return request(resource, { ...options, body: JSON.stringify(effortPayload(payload, { ...input, effort: 'instant' }, outputTokens)) });
    }
    // Summary/metadata requests have independent budgets.
    // The composer controls actual replies only.
    if (!input.effort || input.purpose || internalRequest() || typeof options?.body !== 'string') return request(resource, options);
    const payload = JSON.parse(options.body) as Record<string, unknown>;
    try { return request(resource, { ...options, body: JSON.stringify(effortPayload(payload, input, outputTokens)) }); }
    catch (error) { if (error instanceof Error && error.message === EFFORT_BUDGET_MESSAGE) onBudgetFailure(); throw error; }
  };
}
