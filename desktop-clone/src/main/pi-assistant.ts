import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatExecution } from '../shared/chat';
import { OUTPUT_LIMIT_MESSAGE, TOOL_OUTPUT_LIMIT_MESSAGE, TOOL_LOOP_MESSAGE } from '../shared/chat';
import { toolDefinitions } from '../shared/tools';
import { WorkToolCatalog } from '../core/work-tool-catalog';
import { contextPolicy } from '../core/context';
import { effortPayload } from '../core/effort';
import { openRouterPayload } from '../core/openrouter-policy';
import { scopedFetch } from '../core/librechat';
import { providerActivityFetch } from '../core/provider-activity';
import { ToolLoopGuard } from '../core/tool-loop';
import { focusedPluginToolQuery } from '../core/plugin-tool-query';
import { piPluginToolNames } from '../core/pi-plugin-tools';
import { groundPiServiceTools } from '../core/pi-service-grounding';
import { piProviderFailure } from '../core/pi-errors';
import { assistantToolAllowed, assistantBrowserAccess } from '../core/assistant-tools';
import { AssistantStateTools, assistantRestoredGroup } from '../core/assistant-state-tools';

type PiTool = import('@earendil-works/pi-coding-agent').ToolDefinition<any, any>;
export interface AssistantProfile { root: string; instructions: string; allow: (name: string) => boolean; customTools?: PiTool[]; stateTools?: readonly string[]; background?: boolean }

/** Share Pi's SDK/provider/session machinery, with an assistant prompt and only
 * host-broker tools. No coding CLI, gateway, shell defaults, or global resources. */
export function createPiAssistant(profile: (input: Parameters<ChatExecution['run']>[0]) => Promise<AssistantProfile>): ChatExecution {
  return { async run(input, signal, _onDelta, onTool, onReasoning, onResponse, onContext, onTrace) {
    const options = await profile(input), pi = await import('@earendil-works/pi-coding-agent');
    signal.throwIfAborted();
    await mkdir(options.root, { recursive: true });
    const cwd = join(options.root, 'workspace'), sessions = join(options.root, 'sessions');
    await Promise.all([mkdir(cwd, { recursive: true }), mkdir(sessions, { recursive: true })]);
    const policy = contextPolicy(input), provider = ['custom', 'local'].includes(input.provider) ? 'tinygpt' : input.provider;
    const runtime = await pi.ModelRuntime.create({ authPath: join(options.root, 'auth.json'), modelsPath: null, modelsStorePath: join(options.root, 'models.json'), allowModelNetwork: false, refreshOnCreate: false, signal });
    const api = input.protocol === 'anthropic' ? 'anthropic-messages' : input.protocol === 'openai-responses' ? 'openai-responses' : 'openai-completions';
    runtime.registerProvider(provider, { name: 'TinyGPT', api, baseUrl: input.endpoint, apiKey: input.secret || 'tinygpt-local', models: [{ id: input.model, name: input.model, api, input: input.vision ? ['text', 'image'] : ['text'], reasoning: !!input.reasoning && input.reasoning.kind !== 'none', contextWindow: policy.window, maxTokens: policy.outputTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...(api === 'openai-completions' && provider === 'tinygpt' ? { compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens' as const } } : {}) }] });
    const upstream = runtime.streamSimple.bind(runtime);
    const transport = scopedFetch(input.endpoint, providerActivityFetch(fetch, () => {}, onTrace));
    let currentServiceTools = (): {name:string;label:string}[] => [];
    let serviceActionsAttempted = 0;
    runtime.streamSimple = (model, context, request) => upstream(model, context, { ...request,
      fetch: transport, signal: request?.signal ? AbortSignal.any([signal, request.signal]) : signal,
      maxTokens: policy.outputTokens,
      onPayload: async (body, model) => { const original = await request?.onPayload?.(body, model) ?? body; let result = effortPayload(original as Record<string, unknown>, input, policy.outputTokens); if (input.provider === 'local' && api === 'openai-completions') result = groundPiServiceTools(result,currentServiceTools(),serviceActionsAttempted); return input.provider === 'openrouter' ? openRouterPayload(result, input) : result; },
    });
    let manager: import('@earendil-works/pi-coding-agent').SessionManager | undefined;
    for (const ancestor of [...input.messages].reverse().filter(message => message.role === 'assistant' && message.id)) {
      try { const pointer = JSON.parse(await readFile(join(options.root, `${ancestor.id}.json`), 'utf8')); manager = pi.SessionManager.forkFrom(pointer.file, cwd, sessions); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (!manager) {
      manager = pi.SessionManager.create(cwd, sessions);
      for (const message of input.messages.slice(0,-1)) {
        if (!message.text.trim() || message.text === 'Bot background task') continue;
        if (message.role === 'user') manager.appendMessage({ role: 'user', content: [{ type: 'text', text: message.text }], timestamp: Date.now() });
        else manager.appendCustomMessageEntry('tinygpt-history', `Earlier assistant message:\n${message.text}`, true);
      }
    }
    const definitions = input.tools && onTool ? [...toolDefinitions, ...(input.extensionTools ?? [])].filter(tool => assistantToolAllowed(tool.name) && options.allow(tool.name)) : [];
    const browserAccess = assistantBrowserAccess(definitions,!!options.background);
    const settings = pi.SettingsManager.inMemory({ cacheWarming: 'off', transport: 'sse', compaction: { reserveTokens: policy.outputTokens, keepRecentTokens: Math.min(10000, Math.floor(policy.window * .2)) } });
    const loader = new pi.DefaultResourceLoader({ cwd, agentDir: options.root, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      systemPrompt: browserAccess.notice + "\n\n" + options.instructions + '\n\n' + input.instructions + '\n\nAssistant capabilities: Work-only file, shell, coding and task-history actions are unavailable here. Use declared project file tools for supported file operations. You do not have a tool to create or delegate a separate Work chat. For interactive browser work, load_tools(group:browser) gives the current callable list; in a foreground turn this includes click, type, scroll and key actions when browser access is enabled. Private proactive checks have read-only browser tools. List owned tabs before opening another, and inspect a fresh snapshot after a user signs in. Diagnose access from real tool results, not guesses or earlier messages. bot_watch is for recurring interest checks at a minimum interval of 30 minutes, not pausing the current task or setting a 5-minute reminder. General Personal check-in frequency is controlled by the user in settings.',
      agentsFilesOverride: () => ({ agentsFiles: [] }),
    });
    await loader.reload();
    const catalog = new WorkToolCatalog(definitions, 'chat'), guard = new ToolLoopGuard(true), state = new AssistantStateTools();
    let focusedPluginMode = false;
    let expandedHostTools = false;
    const restoredGroup = !options.background && assistantRestoredGroup(manager.buildSessionProjection().messages);
    if (restoredGroup) { catalog.enable(restoredGroup); expandedHostTools = true; }
    // Give small local models a few relevant read schemas immediately. Only
    // connected/selected captured tools qualify; the broker still checks access.
    if (!options.background && input.tools) {
      const focused = focusedPluginToolQuery((input.extensionTools ?? []).filter(tool => tool.category === 'read' && options.allow(tool.name)),input.messages.at(-1)?.text ?? '',[]);
      if (focused.length && JSON.stringify(focused).length <= Math.min(64000,policy.inputTokens * 1.5)) { catalog.enable('services','',focused.map(tool => tool.name)); focusedPluginMode = true; expandedHostTools = false; }
    }
    let session: import('@earendil-works/pi-coding-agent').AgentSession;
    let fatalToolError: Error | undefined;
    const custom: PiTool[] = input.tools ? (options.customTools ?? []).map(tool => ({ ...tool, async execute(...args: Parameters<PiTool['execute']>) {
      if (guard.blocked(tool.name, args[1])) { fatalToolError = Error(TOOL_LOOP_MESSAGE); void session.abort(); throw fatalToolError; }
      try {
        const result = await tool.execute(...args);
        guard.record(tool.name, args[1], JSON.stringify({isError:(result as {isError?:boolean}).isError === true}));
        if (options.stateTools?.includes(tool.name) && args[1] && Object.keys(args[1]).length && state.record(tool.name, args[1], result.content)) {
          session.setActiveToolsByName(active());
          return { ...result, content: [...result.content, { type: 'text' as const, text: 'This state is already saved. Repeated unchanged saves do not advance the current task. This maintenance tool is unavailable for the remainder of this reply. Continue with the task tools; load_tools can discover another group. Saving a watch does not perform the action described in its prompt.' }] };
        }
        return result;
      }
      catch (error) { guard.record(tool.name, args[1], JSON.stringify({ error: error instanceof Error ? error.message : 'Action failed.' })); throw error; }
    } })) : [];
    const pluginNames = piPluginToolNames((input.extensionTools ?? []).filter(tool => definitions.some(definition => definition.name === tool.name)),[...toolDefinitions.map(tool=>tool.name),...custom.map(tool=>tool.name)]);
    const active = () => [...catalog.available().filter(tool => !focusedPluginMode || tool.name.startsWith('ext_') || ['load_tools','read_source','read_observation'].includes(tool.name)).map(tool => pluginNames.model(tool.name)), ...custom.filter(tool => !state.has(tool.name)).map(tool => tool.name)];
    currentServiceTools = () => catalog.available().filter(tool=>tool.name.startsWith('ext_')).map(tool=>({name:pluginNames.model(tool.name),label:input.extensionTools?.find(extension=>extension.name===tool.name)?.label??tool.name}));
    const tools: PiTool[] = [...definitions.map(definition => ({ name: pluginNames.model(definition.name), label: definition.name, description: !options.background && definition.name === 'browser_open' ? definition.description.replace('Unwatched agent tabs are cleaned up when this reply ends.', 'In this foreground Bot conversation, interactive tabs survive between replies while TinyGPT stays open, even when unwatched.') : definition.description, parameters: definition.schema as PiTool['parameters'],
      async execute(_id: string, args: any) {
        signal.throwIfAborted();
        if (!catalog.has(definition.name)) throw Error('Load the relevant tools first.');
        if (options.background && definition.name === 'load_tools' && args.connect) throw Error('Connect this service from your conversation first.');
        if (definition.name === 'load_tools' && args.group !== 'services') { if (['jobs', 'history'].includes(args.group)) throw Error('This tool group is available only in Work conversations.'); expandedHostTools = true; focusedPluginMode = false; catalog.enable(args.group, args.query); session.setActiveToolsByName(active()); return { content: [{ type: 'text' as const, text: JSON.stringify({ tools: session.getActiveToolNames(), guide: catalog.guide(), browserAccess, notice: 'This is the current callable tool list. Loading another group changes this list, not open tabs. ' + browserAccess.notice }) }], details: undefined }; }
        if (guard.blocked(definition.name, args)) { fatalToolError = Error(TOOL_LOOP_MESSAGE); void session.abort(); throw fatalToolError; }
        if (!options.allow(definition.name)) throw Error('This action is unavailable for this assistant task.');
        const hostArgs = definition.name === 'load_tools' && args.group === 'services' && typeof args.query === 'string' ? { ...args,query:pluginNames.canonical(args.query) } : args;
        let result: string;
        if (definition.name.startsWith('ext_')) serviceActionsAttempted++;
        try { result = await onTool!({ id: randomUUID(), name: definition.name, input: hostArgs }); }
        catch (cause) { guard.record(definition.name,args,JSON.stringify({error:'Tool execution failed.'})); throw cause; }
        guard.record(definition.name, args, result);
        if (definition.name === 'load_tools') { let value: any; try { value = JSON.parse(result); } catch {} if (value?.enabled === 'services' && Array.isArray(value.toolNames)) { catalog.enable('services', args.query, value.toolNames); if (value.toolNames.length && !expandedHostTools) focusedPluginMode = true; session.setActiveToolsByName(active()); return { content:[{type:'text' as const,text:JSON.stringify(pluginNames.loaderResult(value))}],details:undefined }; } }
        return { content: [{ type: 'text' as const, text: result }], details: undefined };
      },
    })), ...custom];
    const created = await pi.createAgentSession({ cwd, agentDir: options.root, modelRuntime: runtime, model: runtime.getModel(provider,input.model)!, thinkingLevel: input.effort === 'instant' ? 'off' : input.effort === 'max' ? 'high' : input.effort ?? 'medium', tools: tools.map(tool => tool.name), customTools: tools, sessionManager: manager, settingsManager: settings, resourceLoader: loader });
    session = created.session; session.setActiveToolsByName(active());
    if (input.replyMessageId && session.sessionFile) await writeFile(join(options.root, `${input.replyMessageId}.json`), JSON.stringify({ file: session.sessionFile }), { mode: 0o600 });
    const replies: string[] = []; let error: unknown, compaction: string | undefined;
    const unsubscribe = session.subscribe(event => { try {
      if (event.type === 'tool_execution_start') onResponse?.({ type: 'tool' });
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'thinking_delta') onReasoning?.(event.assistantMessageEvent.delta);
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        const message = event.message;
        onContext?.({ type: 'usage', inputTokens: message.usage.input + message.usage.cacheRead + message.usage.cacheWrite, outputTokens: message.usage.output });
        const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('\n\n').trim();
        if (!options.background && text && message.stopReason !== 'error' && message.stopReason !== 'aborted' && message.stopReason !== 'length') { replies.push(text); onResponse?.({ type: 'bot-messages', messages: [...replies], complete: false }); }
      }
      if (event.type === 'compaction_start') { compaction = randomUUID(); onContext?.({ type: 'optimizing', id: compaction }); }
      if (event.type === 'compaction_end' && compaction) { onContext?.({ type: event.aborted || event.errorMessage ? 'optimization-failed' : 'optimized', id: compaction }); compaction = undefined; }
    } catch (failure) { error = failure; void session.abort(); } });
    const abort = () => { void session.abort(); }; signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted(); onTrace?.({ event: 'runtime-ready', runtime: 'pi', runtimeVersion: '1.5.0' });
      const last = input.messages.at(-1)!;
      await session.prompt(last.text, { ...(last.images?.length ? { images: last.images.map(data => ({ type: 'image' as const, data: data.slice(data.indexOf(',') + 1), mimeType: /^data:([^;]+);/.exec(data)?.[1] ?? 'image/png' })) } : {}) }).catch(cause => { throw fatalToolError ?? error ?? cause; });
      if (fatalToolError) throw fatalToolError;
      if (error) throw error; signal.throwIfAborted();
      const final = [...session.messages].reverse().find(message => message.role === 'assistant');
      if (final?.role === 'assistant') {
        if (final.stopReason === 'length') throw Error(final.content.some(part => part.type === 'toolCall') ? TOOL_OUTPUT_LIMIT_MESSAGE : OUTPUT_LIMIT_MESSAGE);
        if (final.stopReason === 'error' || final.stopReason === 'aborted') {
          const failure=piProviderFailure(final.errorMessage);
          onTrace?.({event:'worker-stopped',runtime:'pi',failure:'provider',errorCode:failure.errorCode,...(failure.status?{status:failure.status}:{})});
          throw Error(failure.message);
        }
        if (options.background) { const text = final.content.filter(part => part.type === 'text').map(part => part.text).join('\n\n').trim(); input.nativeSilent = !text || /^(NO_REPLY|HEARTBEAT_OK)[.!]?$/i.test(text); if (!input.nativeSilent) replies.push(text); }
      }
      if (replies.length) onResponse?.({ type: 'bot-messages', messages: [...replies], complete: true });
      onResponse?.({ type: 'end' });
    } finally { signal.removeEventListener('abort', abort); await session.abort(); unsubscribe(); session.dispose(); }
  } };
}
