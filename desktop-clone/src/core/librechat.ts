import { visionEvidenceFetch, type ViewedImage } from './vision-evidence';
import { imageToolResult, visionTool } from '../shared/vision';
import { endpointSchema } from '../shared/config';
import type { ChatWorkerInput, ContextEvent, ResponseEvent, RunSteering } from '../shared/chat';
import { OUTPUT_LIMIT_MESSAGE, TOOL_OUTPUT_LIMIT_MESSAGE, COMPACTION_OUTPUT_LIMIT_MESSAGE, TOOL_LOOP_MESSAGE, MODEL_ANSWER_BOUNDARY_MESSAGE, isOutputLimitMessage } from '../shared/chat';
import { ToolLoopGuard } from './tool-loop';
import { browserToolResult } from './browser-snapshot';
import type { BaseMessage } from '@librechat/agents/langchain/messages';
import { chatError, chatFailure } from './chat-errors';
import { randomUUID } from 'node:crypto';
import { agentTools } from './agent-tools';
import { WorkToolCatalog, withoutToolMetadata } from './work-tool-catalog';
import { workToolNames, isWorkOutcome, type WorkControl, type WorkOutcome } from '../shared/work';
import { toolDefinitions, type ToolRequest } from '../shared/tools';
import { isComputerTool, COMPUTER_INSTRUCTIONS } from '../shared/computer';
import { compactPresentParameters } from '../shared/generative-ui';
import { separateToolDisplay, toolApprovalText, approvalTextSchema, toolStatusSchema } from '../shared/tool-display';
import { CHECKPOINT_INSTRUCTIONS, contextPolicy, prepareConversationContext } from './context';
import { compactionFetch } from './compaction';
import { SkillContext, SKILL_CONTEXT_LIMIT_MESSAGE } from './skill-context';
import { providerActivityFetch } from './provider-activity';
import { openRouterStreamFetch } from './openrouter-stream';
import { GenerativeStream } from './generative-stream';
import { PROVIDER_REQUEST_TIMEOUT_MS, type ProviderActivity } from '../shared/chat-timeouts';
import type { TraceEvent } from '../shared/diagnostics';
import { effortFetch } from './effort';
import { localModelFetch, localQueryAnchor, localWorkGuidance } from './local-messages';
import { openRouterPolicyFetch } from './openrouter-policy';
import { openRouterAttributionFetch } from './openrouter-attribution';
import { EFFORT_BUDGET_MESSAGE } from '../shared/effort';
import { MailEvidence } from './mail-evidence';
import { validateLocalAnswer } from './local-answer';
import { structuredMetadataFetch } from './structured-metadata';
import { runtimeContextFetch } from './runtime-context';

export function scopedFetch(endpoint: string, request: typeof fetch = fetch): typeof fetch {
  const attributedRequest = runtimeContextFetch(openRouterAttributionFetch(request));
  const expected = new URL(endpointSchema.parse(endpoint));
  const basePath = expected.pathname.replace(/\/+$/, '');
  return async (resource, options) => {
    const url = new URL(typeof resource === 'string' || resource instanceof URL ? resource.toString() : resource.url);
    if (url.origin !== expected.origin || !(url.pathname === basePath || url.pathname.startsWith(`${basePath}/`))) throw new Error('Provider request outside the configured endpoint.');
    return attributedRequest(resource, { ...options, redirect: 'error' });
  };
}

export function textContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    if (!part || part.type !== 'text') return '';
    if (typeof part.text === 'string') return part.text;
    return typeof part.text?.value === 'string' ? part.text.value : '';
  }).join('');
}

export function reasoningContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => part?.type === 'think' && typeof part.think === 'string' ? part.think : part?.type === 'reasoning' && typeof part.reasoning === 'string' ? part.reasoning : '').join('');
}

export async function runLibreChat(input: ChatWorkerInput, signal: AbortSignal, onDelta: (text: string) => void, onTool?: (request: ToolRequest) => Promise<string>, onReasoning?: (text: string) => void, onResponse?: (event: ResponseEvent) => void, onContext?: (event: ContextEvent) => void, onActivity?: (activity: ProviderActivity) => void, onTrace?: (event: TraceEvent) => void, steering?: RunSteering, _legacyWorkControl?: WorkControl): Promise<void> {
  const { Run, Providers, GraphEvents, createTokenCounter, encodingForModel, HookRegistry, HOOK_PREEMPT_RESTART_CAPABLE } = await import('@librechat/agents');
  const { HumanMessage, AIMessage, ToolMessage } = await import('@librechat/agents/langchain/messages');
  const { DynamicStructuredTool } = await import('@librechat/agents/langchain/tools');
  onTrace?.({ event: 'runtime-ready', purpose: input.purpose ?? 'reply' });
  signal.throwIfAborted();
  const apiKey = input.secret || (input.route === 'local' ? 'tinygpt-local' : '');
  if (!apiKey) throw new Error('Missing provider key.');
  const policy = contextPolicy(input);
  // Reserve pixels separately: graph history holds references and metadata.
  const imageCapacity = input.vision && !input.purpose ? Math.max(1, Math.min(4, Math.floor(policy.inputTokens / 6600))) : 0;
  policy.inputTokens -= imageCapacity * 3300;
  const viewedImages: ViewedImage[] = [];
  let unreviewedImages = 0;
  const tokenCounter = await createTokenCounter(encodingForModel(input.model));
  onTrace?.({ event: 'tokenizer-ready', purpose: input.purpose ?? 'reply' });
  const count = (text: string) => tokenCounter(new HumanMessage(text));
  const localGoal = input.workTask?.goal ?? input.messages.filter(message => message.role === 'user').at(-1)?.text ?? 'Continue the saved conversation.';
  // The final transport can restore a query removed by SDK pruning. Reserve
  // its real token cost before planning context so that repair cannot overflow it.
  if (input.provider === 'local') policy.inputTokens -= count(JSON.stringify(localQueryAnchor([], localGoal))) + 16;
  const skillContext = new SkillContext(count, Math.max(512, Math.floor(policy.inputTokens * 0.35)));
  const mailBudget = input.extensionTools?.some(tool => ['search_mail', 'read_mail'].includes(tool.originalName)) ? Math.min(2000, Math.floor(policy.inputTokens * 0.08)) : 0;
  const mailEvidence = new MailEvidence(input.extensionTools ?? [], input.messages.filter(message => message.role === 'user').map(message => message.text).join('\n'), count, mailBudget);
  let compacting = input.purpose === 'summary';
  let compactionLimitFailed = false;
  const checkpointInstructions = `${CHECKPOINT_INSTRUCTIONS}\nThe checkpoint must be at most ${policy.summaryTokens} visible text tokens. Finish as soon as the checkpoint is complete.`;
  // Observe the original provider bytes before SSE normalization or summary
  // buffering, including partial frames and keepalives.
  let effortBudgetFailed = false;
  const scoped = structuredMetadataFetch(scopedFetch(input.endpoint),input);
  const localTransport = input.provider === 'local' ? localModelFetch(scoped, localGoal) : scoped;
  const adapted = effortFetch(openRouterPolicyFetch(visionEvidenceFetch(localTransport, input.protocol, () => { unreviewedImages = 0; return viewedImages; }, () => compacting), input), input, policy.outputTokens, () => compacting, () => { effortBudgetFailed = true; });
  const transport = providerActivityFetch(adapted, activity => onActivity?.(activity), onTrace, () => input.purpose === 'metadata' ? 'metadata' : compacting ? 'summary' : 'reply');
  const normalizedFetch = input.provider === 'openrouter' && input.protocol === 'openai-compatible'
    ? openRouterStreamFetch(transport, () => { if (!compacting) onResponse?.({ type: 'preparing-tool' }); }) : transport;
  const protectedFetch = skillContext.protect(normalizedFetch, () => compacting || !!input.purpose);
  const summaryFetch = input.purpose === 'metadata' ? protectedFetch : compactionFetch(protectedFetch, () => compacting, { outputTokens: policy.summaryOutputTokens, window: policy.window, retainedTokens: policy.summaryTokens }, count,
    (inputTokens, outputTokens) => onContext?.({ type: 'usage', inputTokens, outputTokens }));
  let finalOutcome: WorkOutcome | undefined;
  let workCatalog: WorkToolCatalog | undefined;
  const loadedPlugins = new Set<string>();
  const fetch: typeof globalThis.fetch = async (resource, options) => {
    try {
      if (finalOutcome) throw new Error('WORK_FINISHED');
      if (workCatalog && !compacting && !input.purpose && typeof options?.body === 'string') {
        let body = workCatalog.select(JSON.parse(options.body));
        if (workCatalog.guide() && Array.isArray(body.messages)) body.messages = localWorkGuidance(body.messages, workCatalog.guide());
        else if (workCatalog.guide() && 'system' in body) body.system = (body.system ?? '') + '\n' + workCatalog.guide();
        else if (workCatalog.guide() && 'input' in body) body.instructions = (body.instructions ?? '') + '\n' + workCatalog.guide();
        options = { ...options, body: JSON.stringify(body) };
      }
      if (!workCatalog && !compacting && !input.purpose && typeof options?.body === 'string') {
        const body = JSON.parse(options.body);
        if (Array.isArray(body.tools)) body.tools = body.tools.flatMap((tool: any) => {
          const name = tool.function?.name ?? tool.name;
          if (!name?.startsWith('ext_')) return [tool];
          if (!loadedPlugins.has(name)) return [];
          const definition = availableTools.find(item => item.name === name);
          if (!definition) return [];
          return tool.function ? [{ ...tool, function: { ...tool.function, description: definition.description, parameters: definition.schema } }] : [{ ...tool, description: definition.description, ...('input_schema' in tool ? { input_schema: definition.schema } : { parameters: definition.schema }) }];
        });
        options = { ...options, body: JSON.stringify(body) };
      }
      if (mailBudget && typeof options?.body === 'string') options = { ...options, body: JSON.stringify(mailEvidence.restore(JSON.parse(options.body))) };
      return await summaryFetch(resource, options);
    }
    catch (error) {
      if (error instanceof Error && error.message === COMPACTION_OUTPUT_LIMIT_MESSAGE) compactionLimitFailed = true;
      throw error;
    }
  };
  const toMessage = (message: ChatWorkerInput['messages'][number]) => message.role === 'user' ? new HumanMessage({ id: message.id, content: message.images?.length ? [{ type: 'text', text: message.text }, ...message.images.map(url => ({ type: 'image_url' as const, image_url: { url } }))] : message.text }) : new AIMessage({ id: message.id, content: message.text });
  const toMessages = (message: ChatWorkerInput['messages'][number]) => {
    const operations = message.operations?.filter(op => ['succeeded', 'failed', 'unknown', 'cancelled'].includes(op.status) && !JSON.stringify(op.input).includes('[redacted]')) ?? [];
    return [...operations.flatMap(op => [new AIMessage({ id: 'call-' + op.id, content: '', tool_calls: [{ id: op.id, name: op.name, args: op.input }] }), new ToolMessage({ id: 'result-' + op.id, tool_call_id: op.id, content: JSON.stringify({ recordedOutcome: op.status, result: op.result, workEvidenceId: op.id, workEvidenceRef: op.ref }), status: op.status === 'succeeded' ? 'success' : 'error' })]), toMessage(message)];
  };
  let availableTools = [...agentTools(input), ...(input.extensionTools ?? []).map(tool => ({ ...tool, schema: { ...tool.schema, properties: { ...(tool.schema.properties as Record<string, unknown> ?? {}), __tinygpt_status: toolStatusSchema, __tinygpt_approval: approvalTextSchema } } }))];
  if (input.mode === 'code') {
    availableTools = availableTools.map(withoutToolMetadata); workCatalog = new WorkToolCatalog(availableTools);
    for (const message of input.messages) for (const op of message.operations ?? []) if (op.name === 'load_tools' && op.status === 'succeeded') { try { const result = JSON.parse(op.result); if (typeof result.enabled === 'string' && result.enabled !== 'services') workCatalog.enable(result.enabled, result.query, result.toolNames); } catch { /* Ignore interrupted/legacy loads. */ } }
  } else if (input.mode !== 'bot' && !input.purpose) {
    // Keep every tool callable in the SDK registry, but advertise only the
    // common tools plus one explicitly discovered group at the provider boundary.
    workCatalog = new WorkToolCatalog(availableTools, 'chat');
  }
  const workSchemaBudget = workCatalog ? Math.max(count(JSON.stringify(workCatalog.available())), Math.min(10000, Math.floor(policy.inputTokens * (input.mode === 'code' ? 0.25 : 0.5)))) : 0;
  // The SDK registry has tiny permissive schemas; reserve space for the real
  // active schemas inserted at transport time, including desktop guidance.
  const pluginSchemaReserve = Math.min(10000, Math.ceil((input.extensionTools ?? []).map(tool => count(JSON.stringify(tool))).sort((a, b) => b - a).slice(0, 20).reduce((sum, size) => sum + size, 0) * 1.15));
  // Chat's SDK reconciles its tool overhead with provider-reported prompt usage.
  // Subtracting a second full catalog reserve makes that corrected overhead count
  // twice and can leave no room for messages. The catalog admission check below
  // bounds discovery; the SDK retains the full input budget for measured usage.
  const schemaReserve = workCatalog && input.mode !== 'code' ? 0 : workCatalog ? workSchemaBudget + count(COMPUTER_INSTRUCTIONS) : pluginSchemaReserve;
  const advertisedTools = () => workCatalog?.available() ?? availableTools.filter(tool => !tool.name.startsWith('ext_') || loadedPlugins.has(tool.name));
  const fits = () => count(input.instructions) + Math.ceil(count(JSON.stringify(advertisedTools())) * 1.15) + policy.summaryTokens < policy.inputTokens;
  if (input.tools && !fits()) {
    availableTools = availableTools.map(tool => tool.name === 'present' ? { ...tool, schema: { ...compactPresentParameters, properties: { status: toolStatusSchema, permission: approvalTextSchema, ...compactPresentParameters.properties } } } : tool);
    // Display metadata repeats on every tool. Shorten its documentation for
    // small windows while preserving arguments, validation and host policy.
    if (!fits()) availableTools = availableTools.map(tool => ({ ...tool, schema: { ...tool.schema, properties: { ...tool.schema.properties, ...Object.fromEntries(Object.entries(tool.schema.properties as Record<string, unknown>).map(([key, value]) => [key,
      ['status', '__tinygpt_status'].includes(key) ? { ...toolStatusSchema, description: 'Brief action status. Never print it in the answer.' }
        : ['permission', '__tinygpt_approval'].includes(key) ? { ...approvalTextSchema, description: 'Optional May I... approval question. Host policy controls approval; never print or wait for it yourself.' } : value])) } } } as typeof tool));
    // JSON Schema dialect markers add no argument information. Removing them
    // reduces repeated framing in small windows without changing validation.
    if (!fits()) availableTools = availableTools.map(tool => { const { $schema, ...schema } = tool.schema as typeof tool.schema & { $schema?: string }; return { ...tool, schema } as typeof tool; });
    // Host validators enforce bounds. Keep native argument names/types and
    // enums, but omit repeated validation hints when a small model needs room.
    if (!fits()) {
      const compact = (value: unknown): unknown => Array.isArray(value) ? value.map(compact) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => !['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'format', 'pattern', 'default', '$schema'].includes(key)).map(([key, item]) => [key, compact(item)])) : value;
      availableTools = availableTools.map(tool => tool.name.startsWith('ext_') ? tool : { ...tool, schema: compact(tool.schema) } as typeof tool);
    }
    if (!fits()) availableTools = availableTools.map(tool => ({ ...tool, description: tool.description.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ') }));
    // Keep the complete visual catalog through normal schema compaction. Only
    // an otherwise unusable context can omit it as a final fallback.
    if (!fits()) {
      availableTools = availableTools.filter(tool => tool.name !== 'present');
    }
  }
  const fixedTokens = count(input.instructions) + (input.tools ? Math.ceil(count(JSON.stringify(advertisedTools())) * 1.15) : 0);
  onTrace?.({ event: 'context-budget', purpose: input.purpose ?? 'reply', budgetTokens: policy.inputTokens, fixedTokens });
  if (input.purpose === 'metadata' && fixedTokens + input.messages.reduce((sum, message) => sum + count(message.text) + 8, 0) > policy.inputTokens) throw new Error('Description input exceeded its limit.');
  const prepared = input.purpose ? { messages: input.messages, summary: '', throughMessageId: undefined } : await prepareConversationContext(input, count,
    fixedTokens, signal,
    async (transcript, prior) => {
      let text = '';
      await runLibreChat({ ...input, runId: randomUUID(), purpose: 'summary', tools: false, checkpoint: undefined,
        instructions: checkpointInstructions,
        messages: [{ role: 'user', text: `${prior ? `Previous checkpoint:\n${prior}\n\n` : ''}Transcript to incorporate:\n${transcript}` }],
      }, signal, delta => { text += delta; }, undefined, undefined, undefined, event => { if (event.type === 'usage') onContext?.(event); }, onActivity, onTrace);
      return text;
    }, onContext, message => toMessages(message).reduce((n, item) => n + tokenCounter(item) + 8, 0));
  const common = { apiKey, model: input.model, streaming: true, maxTokens: input.purpose === 'summary' ? policy.summaryOutputTokens : policy.outputTokens, maxRetries: 0, timeout: PROVIDER_REQUEST_TIMEOUT_MS, _lc_stream_delay: 0 };
  const llmConfig = input.protocol === 'anthropic'
    ? { ...common, provider: Providers.ANTHROPIC, clientOptions: { baseURL: input.endpoint.replace(/\/v1\/?$/, ''), fetch, maxRetries: 0 } }
    : { ...common, provider: Providers.OPENAI, useResponsesApi: input.protocol === 'openai-responses', firstPartyEndpoint: input.provider === 'openai' && new URL(input.endpoint).origin === 'https://api.openai.com', configuration: { baseURL: input.endpoint.replace(/\/+$/, ''), fetch, maxRetries: 0 } };
  let streamedText = '';
  let totalTextSize = 0;
  let textStep: string | undefined;
  let toolsStarted = false;
  const phases = new Map<string, 'progress' | 'answer'>();
  const interfaces = new GenerativeStream(event => { if (!signal.aborted && !compacting && !input.purpose) onResponse?.(event); });
  let answerBeforeTools = false;
  let localPrelude = '';
  let presentedAnswer = false;
  function beginTools() {
    if (toolsStarted || signal.aborted) return;
    answerBeforeTools = !!streamedText.trim() && phases.get(textStep ?? '') !== 'progress';
    if (holdLocalAnswer) localPrelude = streamedText;
    toolsStarted = true; streamedText = ''; textStep = undefined;
    onResponse?.({ type: 'tool' });
  }
  const workParts = new Map<string, string>();
  const workPart = (id: string, kind: 'prose' | 'reasoning', delta: string) => { if (input.mode !== 'code') return; const text = (workParts.get(id) ?? '') + delta; workParts.set(id, text); onResponse?.({ type: 'work-part', id, kind, text }); };
  const reportOutcome = () => {
    if (!finalOutcome) return;
    textStep = 'outcome-' + randomUUID(); phases.set(textStep, 'answer');
    streamedText = finalOutcome.answer ?? finalOutcome.summary; totalTextSize += streamedText.length;
    onResponse?.({ type: 'start', lane: 'answer' }); onDelta(streamedText);
    workPart('prose-' + textStep, 'prose', streamedText);
  };
  let reasoningSize = 0;
  // Known local thinking models can emit content before their reasoning really
  // ends. Publish their Chat answer only after a successful terminal result.
  // Other providers and Work keep their normal streaming behavior.
  const holdLocalAnswer = input.provider === 'local' && input.reasoning?.kind === 'llamacpp' && !input.purpose && input.mode !== 'code' && input.mode !== 'bot';
  const optimizationController = new AbortController();
  const loopController = new AbortController();
  const loopGuard = new ToolLoopGuard(input.mode === 'code');
  const executionSignal = AbortSignal.any([signal, optimizationController.signal, loopController.signal]);
  const callTool = async (request: ToolRequest): Promise<string> => {
    // A prelude belongs only to this tool step. Never replay a research
    // update as answer text when a later, tool-only step presents a visual.
    const precedingLocalText = localPrelude; localPrelude = '';
    executionSignal.throwIfAborted();
    if (finalOutcome) return JSON.stringify({ error: 'The Work outcome is already recorded. No additional action was executed.', outcome: finalOutcome });
    if (loopGuard.blocked(request.name, request.input)) { loopController.abort(); throw new Error(TOOL_LOOP_MESSAGE); }
    const imageRequest = input.vision && request.name === 'view_image';
    if (imageRequest && unreviewedImages >= imageCapacity) return JSON.stringify({ error: `Review the current image results before viewing more. This model's context supports ${imageCapacity} images per batch; reopen earlier references as needed.` });
    if (imageRequest) unreviewedImages++;
    let result: string;
    if (workCatalog && request.name === 'load_tools' && request.input && typeof request.input === 'object') {
      const { group, query } = request.input as { group?: string; query?: string };
      if (typeof group === 'string' && group !== 'services' && (query === undefined || typeof query === 'string')) {
        const issue = workCatalog.selectionIssue(group, query, workSchemaBudget, count);
        if (issue) request = { ...request, validationError: JSON.stringify(issue) };
      }
    }
    if (!workCatalog && request.name.startsWith('ext_') && !loadedPlugins.has(request.name)) request = { ...request, validationError: JSON.stringify({ error: 'Load the plugin action with load_tools before calling it. Nothing was executed.', code: 'TOOLS_NOT_LOADED', executed: false }) };
    if (!request.validationError) { const mismatch = mailEvidence.check(request.name, request.input as Record<string, unknown>); if (mismatch) request = { ...request, validationError: mismatch }; }
    if (workCatalog && !workCatalog.has(request.name)) request = { ...request, validationError: JSON.stringify({ error: `Load ${workCatalog.groupFor(request.name) ?? 'the relevant'} tools before calling ${request.name}. Nothing was executed.`, code: 'TOOLS_NOT_LOADED', tool: request.name, executed: false, nextAction: 'Call load_tools with the indicated group.' }) };
    // A complete, accepted presentation call is a valid answer boundary. Keep
    // its preceding prose in front of the visual; truncated calls never get here.
    if (holdLocalAnswer && request.name === 'present' && !request.validationError && precedingLocalText.trim()) { validateLocalAnswer(precedingLocalText); onResponse?.({ type: 'start', lane: 'answer' }); onDelta(precedingLocalText); }
    try { result = await onTool!(request); } catch (error) { if (imageRequest) unreviewedImages--; throw error; }
    mailEvidence.remember(request.name, request.input as Record<string, unknown>, result);
    if (request.name === 'work_finish') {
      try { const value = JSON.parse(result); if (value.accepted && isWorkOutcome(value.task?.status)) finalOutcome = { status: value.task.status, summary: value.task.summary, answer: value.task.answer }; } catch { /* Invalid tool results cannot end a run. */ }
    }
    if (request.name === 'load_tools') { try { const value = JSON.parse(result); if (!value.error && typeof value.enabled === 'string') {
      const issue = workCatalog?.selectionIssue(value.enabled, value.query, workSchemaBudget, count, value.enabled === 'services' ? value.toolNames ?? [] : undefined);
      if (issue) result = JSON.stringify(issue);
      else { workCatalog?.enable(value.enabled, value.query, value.toolNames); if (value.enabled === 'services' && Array.isArray(value.toolNames)) { loadedPlugins.clear(); for (const name of value.toolNames) if (input.extensionTools?.some(tool => tool.name === name)) loadedPlugins.add(name); } }
    } } catch { /* Invalid load results never activate tools. */ } }
    if (request.name === 'present' && answerBeforeTools) {
      try { if (JSON.parse(result).presented === true) presentedAnswer = true; } catch { /* Only a successful presentation retains an accepted answer. */ }
    }
    skillContext.remember(request.name, result);
    const viewed = input.vision ? imageToolResult(request.name, result) : null;
    if (imageRequest && !viewed) unreviewedImages--;
    if (viewed) { viewedImages.push(viewed); while (viewedImages.length > imageCapacity) viewedImages.shift(); }
    const text = viewed?.text ?? result;
    loopGuard.record(request.name, request.input, text);
    return request.name === 'read_page' || request.name.startsWith('browser_') ? browserToolResult(text, Math.min(12000, policy.inputTokens)) : text;
  };
  let optimizationFailed = false;
  const tools = input.tools && onTool ? availableTools.map(definition => new DynamicStructuredTool({ name: definition.name, description: workCatalog || definition.name.startsWith('ext_') ? '' : definition.description, schema: workCatalog || definition.name.startsWith('ext_') ? {} : definition.schema, func: async (args: unknown, _manager, config) => {
    signal.throwIfAborted(); beginTools();
    if ((workToolNames as readonly string[]).includes(definition.name)) return callTool({ id: randomUUID(), name: definition.name as ToolRequest["name"], input: args });
    if (definition.name.startsWith('ext_')) { const { __tinygpt_status, __tinygpt_approval, ...input } = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>; return callTool({ id: randomUUID(), name: definition.name as ToolRequest['name'], input, displayText: typeof __tinygpt_status === 'string' ? __tinygpt_status.slice(0, 48) : undefined, approvalText: toolApprovalText(__tinygpt_approval) }); }
    const runtime = config as { toolCallId?: string; toolCall?: { id?: string } } | undefined;
    return callTool({ id: definition.name === 'present' ? interfaces.claim(args, runtime?.toolCallId ?? runtime?.toolCall?.id) : randomUUID(), name: definition.name as ToolRequest["name"], ...separateToolDisplay(args) });
  } })) : [];
  const hooks = (steering || input.mode === 'code') && !input.purpose ? new HookRegistry() : undefined;
  if (hooks && steering) {
    if (!HOOK_PREEMPT_RESTART_CAPABLE) throw new Error('The chat runtime does not support steering.');
    const drain = () => { const pending = steering.pending(); const consumed = new Set(steering.consume(pending.map(item => item.id)).map(item => item.id)); return ({ injectedMessages: pending.filter(item => consumed.has(item.id)).map(item => ({ role: 'user' as const, source: 'steer' as const, content: item.images?.length ? [{ type: 'text' as const, text: item.text }, ...item.images.map(url => ({ type: 'image_url' as const, image_url: { url } }))] : item.text })) }); };
    hooks.register('PreemptBoundary', { hooks: [drain] });
    hooks.register('PostToolBatch', { hooks: [drain] });
    hooks.register('Stop', { hooks: [() => { const result = drain(); return result.injectedMessages.length ? { ...result, decision: 'block' as const } : {}; }] });
  }
  if (hooks && input.mode === 'code') {
    hooks.register('PostToolBatch', { hooks: [() => finalOutcome ? { preventContinuation: true, stopReason: 'Work answer recorded' } : {}] });
  }
  const transcript: BaseMessage[] = prepared.messages.flatMap(toMessages);
    const run = await Run.create({
      hooks,
      preemption: hooks && steering ? { shouldPreempt: () => steering.pending().length > 0, subscribe: (wake: () => void) => steering.subscribe(wake), restartGraceMs: 0, maxSeals: 20 } : undefined,
      runId: input.runId,
      tokenCounter,
      graphConfig: { type: 'standard', instructions: input.instructions, llmConfig, tools,
        maxContextTokens: policy.inputTokens - schemaReserve - mailBudget,
        summarizationEnabled: !input.purpose,
        summarizationConfig: { prompt: checkpointInstructions, updatePrompt: checkpointInstructions, maxSummaryTokens: policy.summaryOutputTokens, reserveRatio: 0.05, retainRecent: { turns: 2, tokens: Math.floor(policy.inputTokens * 0.4) } },
        initialSummary: prepared.summary ? { text: prepared.summary, tokenCount: count(prepared.summary) } : undefined,
        contextPruningConfig: { enabled: true, keepLastAssistants: 2, softTrimRatio: 0.3, hardClearRatio: 0.6, minPrunableToolChars: 6000 },
        maxToolResultChars: Math.min(12000, policy.inputTokens),
      },
      langfuse: { enabled: false }, returnContent: true,
      streamLimits: { maxDeltaEventsPerTurn: 100000 },
      customHandlers: {
        [GraphEvents.ON_MODEL_RESPONSE]: {
          handle: async (_event: string, data: { toolCalls?: { name: string; args?: unknown }[]; invalidToolCalls?: { name?: string }[] }) => {
            if (holdLocalAnswer && !compacting) validateLocalAnswer(streamedText);
            if (!workCatalog || !onTool || signal.aborted || compacting) return;
            const rejected = [...(data.toolCalls ?? []).filter(call => !availableTools.some(tool => tool.name === call.name)).map(call => ({ ...call, code: 'UNKNOWN_TOOL' })), ...(data.invalidToolCalls ?? []).map(call => ({ name: call.name ?? 'unknown_tool', args: { invalidArguments: true }, code: 'INVALID_TOOL_JSON' }))];
            for (const call of rejected) {
              const name = call.name.slice(0, 200) as ToolRequest['name'], args = call.args ?? {};
              if (loopGuard.blocked(name, args)) { loopController.abort(); throw new Error(TOOL_LOOP_MESSAGE); }
              const result = await onTool({ id: randomUUID(), name, input: args, validationError: JSON.stringify({ error: call.code === 'UNKNOWN_TOOL' ? `Tool ${name} is not declared. Nothing was executed.` : `Arguments for ${name} are not valid JSON. Nothing was executed.`, code: call.code, tool: name, executed: false, nextAction: 'Use a declared tool name and a complete JSON object matching its fields.' }) });
              loopGuard.record(name, args, result);
            }
          },
        },
        [GraphEvents.ON_RUN_STEP_DELTA]: {
          handle: (_event: string, data: { id: string; delta?: { tool_calls?: { id?: string; index?: number; name?: string; args?: string }[] } }) => {
            if (!holdLocalAnswer && !signal.aborted && !compacting && !input.purpose && input.mode !== 'code' && input.mode !== 'bot' && tools.some(tool => tool.name === 'present')) interfaces.delta(data.id, data.delta?.tool_calls ?? []);
          },
        },
        [GraphEvents.ON_SUMMARIZE_START]: {
          handle: () => { compacting = true; onContext?.({ type: 'optimizing', id: input.runId }); },
        },
        [GraphEvents.ON_SUMMARIZE_COMPLETE]: {
          handle: (_event: string, data: { summary?: { content?: unknown; coverage?: { retainedFromMessageId: string } }; error?: string }) => {
            const text = textContent(data.summary?.content);
            compacting = false;
            // The SDK can fall back to a role-count-only metadata stub when its
            // summarizer fails. Never persist that stub as conversation memory.
            if (data.error || !text.trim() || text.startsWith('[Metadata summary:') || text.length > 32000) {
              optimizationFailed = true;
              onContext?.({ type: 'optimization-failed', id: input.runId });
              optimizationController.abort();
              return;
            }
            const anchor = data.summary?.coverage?.retainedFromMessageId;
            const retainedIndex = anchor ? prepared.messages.findIndex(message => message.id === anchor) : -1;
            // Only a known input boundary proves the summary contains historical
            // messages alone. A generated tool-loop boundary may include actions
            // from this reply; anchoring those to its shared user message would
            // leak them into a regenerated sibling. Keep such summaries in this
            // run; its saved answer and tool outcomes are compacted on a later turn.
            const through = retainedIndex > 0 ? prepared.messages.slice(0, retainedIndex).filter(message => message.id).at(-1)?.id : undefined;
            if (through && text.length <= 32000) onContext?.({ type: 'checkpoint', id: input.runId, checkpoint: { throughMessageId: through, text } });
            onContext?.({ type: 'optimized', id: input.runId });
          },
        },
        [GraphEvents.ON_RUN_STEP]: {
          handle: (_event: string, data: { id?: string; type?: string; stepDetails?: { message_creation?: { phase?: string } } }) => {
            if (data.type === 'tool_calls') beginTools();
            const phase = data.stepDetails?.message_creation?.phase;
            if (data.id && data.type === 'message_creation' && (phase === 'commentary' || phase === 'final_answer')) phases.set(data.id, phase === 'commentary' ? 'progress' : 'answer');
          },
        },
        [GraphEvents.ON_REASONING_DELTA]: {
          handle: (_event: string, data: { delta?: { content?: unknown } }) => {
            const text = reasoningContent(data.delta?.content);
            if (!text || signal.aborted) return;
            reasoningSize += text.length;
            if (reasoningSize > 500000) throw new Error('Response limit exceeded.');
            onReasoning?.(text); workPart('reasoning-' + (textStep ?? totalTextSize), 'reasoning', text);
          },
        },
        [GraphEvents.ON_RUN_STEP_CLOSED]: {
          handle: (_event: string, data: { id?: string; type?: string; status?: string }) => {
            if (!holdLocalAnswer && data.type === 'message_creation' && data.status === 'completed' && data.id === textStep && !signal.aborted) onResponse?.({ type: 'end' });
          },
        },
        [GraphEvents.ON_MESSAGE_DELTA]: {
          handle: (_event: string, data: { id?: string; delta?: { content?: unknown } }) => {
            const text = textContent(data.delta?.content);
            if (!text || signal.aborted) return;
            if (textStep !== data.id || toolsStarted || totalTextSize === 0) {
              textStep = data.id; toolsStarted = false; streamedText = '';
              // Unphased Chat text is visible from its first token. If the model
              // later calls tools, the host moves that prelude into progress.
              if (!holdLocalAnswer) onResponse?.({ type: 'start', lane: phases.get(data.id ?? '') ?? (input.mode === 'code' && tools.length ? 'unclassified' : 'answer') });
            }
            streamedText += text;
            if (holdLocalAnswer) validateLocalAnswer(streamedText);
            totalTextSize += text.length;
            if (totalTextSize > 500000) throw new Error('Response limit exceeded.');
            if (!holdLocalAnswer) onDelta(text); workPart('prose-' + data.id, 'prose', text);
          },
        },
      },
    });
    try {
      const content = await run.processStream({ messages: transcript }, {
        // LangGraph requires a positive numeric ceiling. Use its practical maximum
        // instead of imposing an interactive step budget; abort and context/tool
        // deadlines remain independent of the number of successful actions.
        version: 'v2', run_id: input.runId, signal: executionSignal, recursionLimit: Number.MAX_SAFE_INTEGER, configurable: { thread_id: input.runId },
      });
      signal.throwIfAborted();
      if (holdLocalAnswer && run.getOutputTruncated()) throw new Error(OUTPUT_LIMIT_MESSAGE);
      if (holdLocalAnswer && streamedText.trim()) { validateLocalAnswer(streamedText); onResponse?.({ type: 'start', lane: 'answer' }); onDelta(streamedText); }
      if (finalOutcome && !run.getOutputTruncated() && (!streamedText.trim() || phases.get(textStep ?? '') === 'progress')) {
        // A reportable outcome is valid even when the provider supplies no
        // closing prose. Preserve its accepted summary as the final answer.
        reportOutcome();
      }
      for (const message of run.getRunMessages() ?? []) {
        const usage = 'usage_metadata' in message ? message.usage_metadata as { input_tokens?: number; output_tokens?: number } | undefined : undefined;
        if (usage) onContext?.({ type: 'usage', inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 });
      }
      if (!totalTextSize) {
        const text = textContent(content);
        if (text) { if (holdLocalAnswer) validateLocalAnswer(text); onResponse?.({ type: 'start', lane: 'answer' }); onDelta(text); }
        else if (!run.getOutputTruncated()) throw new Error('Provider returned no text.');
      }
      if (run.getOutputTruncated()) throw new Error(OUTPUT_LIMIT_MESSAGE);
      if (input.mode === 'code') onResponse?.({ type: 'work-complete', answerPartIds: textStep ? ['prose-' + textStep] : [] });
      if (totalTextSize && !presentedAnswer && (!streamedText.trim() || phases.get(textStep ?? '') === 'progress')) throw new Error('Provider returned no final text.');
      return;
    } catch (error) {
      if (signal.aborted) throw error;
      if (finalOutcome) { reportOutcome(); onResponse?.({ type: 'work-complete', answerPartIds: textStep ? ['prose-' + textStep] : [] }); return; }
      if (effortBudgetFailed) throw new Error(EFFORT_BUDGET_MESSAGE);
      if (error instanceof Error && (error.message === MODEL_ANSWER_BOUNDARY_MESSAGE || error.message === SKILL_CONTEXT_LIMIT_MESSAGE || error.message === EFFORT_BUDGET_MESSAGE || isOutputLimitMessage(error.message))) throw error;
      if (loopController.signal.aborted) throw new Error(TOOL_LOOP_MESSAGE);
      if (compactionLimitFailed || error instanceof Error && error.message === COMPACTION_OUTPUT_LIMIT_MESSAGE) throw new Error(COMPACTION_OUTPUT_LIMIT_MESSAGE);
      if (optimizationFailed) throw new Error('Conversation optimization could not finish. Your history is preserved; retry this reply.');
      if (error instanceof Error && error.name === 'OutputTruncationError') throw new Error(TOOL_OUTPUT_LIMIT_MESSAGE);
      onTrace?.({ event: 'worker-stopped', ...chatFailure(error) });
      throw new Error(chatError(error));
    } finally { interfaces.clear(); }
}
