import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatExecution } from '../shared/chat';
import { OUTPUT_LIMIT_MESSAGE, TOOL_OUTPUT_LIMIT_MESSAGE } from '../shared/chat';
import { toolDefinitions, type NativeCodeToolName } from '../shared/tools';
import { simpleWorkToolDefinitions } from '../shared/work';
import { WorkToolCatalog, withoutToolMetadata } from '../core/work-tool-catalog';
import { StableWorkTools, invokeWorkTool, STABLE_WORK_TOOL_INSTRUCTIONS } from '../core/stable-work-tools';
import { contextPolicy } from '../core/context';
import { effortPayload } from '../core/effort';
import { workEffortPayload } from '../core/work-effort';
import { workRequestPayload } from '../core/work-request';
import { assertWorkEditSize, INCREMENTAL_WORK_INSTRUCTIONS, WorkLimitRecovery, WorkOutputLimitError, workToolPayload } from '../core/work-limits';
import { importedWorkHistory, workOutputBudget } from '../core/work-history-import';
import { openRouterPayload } from '../core/openrouter-policy';
import { scopedFetch } from '../core/librechat';
import { providerActivityFetch } from '../core/provider-activity';
import { chatError } from '../core/chat-errors';
import type { HistoryStore } from './history';
import { prepareFileDestination, fileDestination } from './file-destination';
import { codeShellEnvironment, bundledNodePowerShell } from './code-shell';
import { runCodeTask } from './work-code';
import { preparePiTools } from './work-tools';
import { ObservationStore } from './observations';
import { workContextExtension, repairWorkArgumentHistory } from './work-context';
import { workContextPolicy } from '../core/work-context-policy';
import { workDisplayTail } from '../core/work-activity';

const replacedTools = new Set(['list_files', 'read_file', 'search_files', 'write_file', 'edit_file', 'run_command', 'list_project_files', 'read_project_file', 'write_project_file', 'create_project_directory', 'edit_project_file', 'run_project_command']);
type PiTool = import('@earendil-works/pi-coding-agent').ToolDefinition<any, any>;

/** Pi owns its session, tool loop, compaction and recovery. This adapter connects UI and model. */
export function createWorkExecution(history: HistoryStore, checkBrowserAccess?: () => void): ChatExecution {
  return {
    async run(input, signal, onDelta, onTool, onReasoning, onResponse, onContext, onTrace, onNativeCode, steering) {
      if (!onTool || !onNativeCode || !input.conversationId) throw new Error('Work tools are unavailable.');
      await preparePiTools(join(dirname(history.databasePath), 'work-runtime'));
      const pi = await import('@earendil-works/pi-coding-agent');
      signal.throwIfAborted();
      const { root: directory } = await prepareFileDestination(history, input.conversationId, signal);
      const root = join(dirname(history.databasePath), 'work-runtime', input.conversationId);
      const agentDir = join(root, 'agent'), sessionDir = join(root, 'sessions'), pointers = join(root, 'messages');
      await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(sessionDir, { recursive: true }), mkdir(pointers, { recursive: true })]);
      const policy = contextPolicy(input);
      const stableTools = input.provider === 'local' && input.protocol === 'openai-compatible';
      const recovery = new WorkLimitRecovery();
      const revision = () => history.codeChanges(input.conversationId!).filter(change => change.state === 'applied').map(change => change.id).sort().join(',');
      const contextSettings = workContextPolicy(policy.window, policy.outputTokens, policy.inputTokens);
      const observations = new ObservationStore(history.databasePath === ':memory:' ? join(history.generatedFilesRoot, 'library.sqlite') : history.databasePath);
      const provider = ['local', 'custom'].includes(input.provider) ? 'tinygpt' : input.provider;
      const runtime = await pi.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, modelsStorePath: join(agentDir, 'models.json'), allowModelNetwork: false, refreshOnCreate: false, signal });
      const api = input.protocol === 'anthropic' ? 'anthropic-messages' : input.protocol === 'openai-responses' ? 'openai-responses' : 'openai-completions';
      runtime.registerProvider(provider, {
        name: 'TinyGPT', api, baseUrl: input.endpoint, apiKey: input.secret || 'tinygpt-local',
        models: [{ id: input.model, name: input.model, api, input: input.vision ? ['text', 'image'] : ['text'], reasoning: !!input.reasoning && input.reasoning.kind !== 'none', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: policy.window, maxTokens: policy.outputTokens, ...(api === 'openai-completions' && provider === 'tinygpt' ? { compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens' as const } } : {}) }],
      });
      const upstream = runtime.streamSimple.bind(runtime);
      const transports = {
        reply: scopedFetch(input.endpoint, providerActivityFetch(fetch, () => {}, event => onTrace?.({ ...event, runtime: 'pi' }), () => 'reply')),
        summary: scopedFetch(input.endpoint, providerActivityFetch(fetch, () => {}, event => onTrace?.({ ...event, runtime: 'pi' }), () => 'summary')),
      };
      const stream: typeof runtime.streamSimple = (model, context, options) => requestStream(model, context, options, 'reply');
      const requestStream = (model: Parameters<typeof upstream>[0], context: Parameters<typeof upstream>[1], options: Parameters<typeof upstream>[2], purpose: 'reply' | 'summary'): ReturnType<typeof upstream> => upstream(model, context, {
        ...options, fetch: transports[purpose], signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal,
        maxTokens: Math.min(options?.maxTokens ?? policy.outputTokens, purpose === 'summary' ? contextSettings.summaryOutputTokens : policy.outputTokens),
        onPayload: async (body, model) => {
          if (purpose === 'reply') recovery.assertAvailable();
          const prepared = workToolPayload((await options?.onPayload?.(body, model) ?? body) as Record<string, unknown>);
          const outputBudget = workOutputBudget(prepared as Record<string, unknown>, purpose === 'summary' ? contextSettings.summaryOutputTokens : policy.outputTokens);
          let payload = purpose === 'summary' ? effortPayload(prepared as Record<string, unknown>, { ...input, effort: 'instant' }, outputBudget) : workEffortPayload(prepared as Record<string, unknown>, input, outputBudget);
          if (input.provider === 'openrouter') payload = openRouterPayload(payload, input);
          return workRequestPayload(payload, input);
        },
      });
      runtime.streamSimple = stream;
      let manager: import('@earendil-works/pi-coding-agent').SessionManager | undefined;
      // Each assistant reply forks its selected ancestor, preserving edits and regenerated branches.
      const ancestors = input.workAncestorMessageIds ?? input.messages.filter(message => message.role === 'assistant' && message.id).map(message => message.id!);
      for (const messageId of [...ancestors].reverse()) {
        try {
          const previous = JSON.parse(await readFile(join(pointers, `${messageId}.json`), 'utf8'));
          if (previous.cwd !== directory) continue;
          await access(previous.file); manager = pi.SessionManager.forkFrom(previous.file, directory, sessionDir); break;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      if (!manager) {
        manager = pi.SessionManager.create(directory, sessionDir);
        for (const entry of importedWorkHistory(input)) {
          if (entry.role === 'user') manager.appendMessage({ role: 'user', content: [{ type: 'text', text: entry.text }], timestamp: Date.now() });
          else manager.appendCustomMessageEntry('tinygpt-import', entry.text, false);
        }
      }
      if (stableTools) repairWorkArgumentHistory(manager);
      const settings = pi.SettingsManager.inMemory({ cacheWarming: 'off', transport: 'sse', compaction: { reserveTokens: stableTools ? contextSettings.compactionReserveTokens : policy.outputTokens, keepRecentTokens: contextSettings.keepRecentTokens } });
      const compact = async (event: import('@earendil-works/pi-coding-agent').SessionBeforeCompactEvent) => {
        const model = runtime.getModel(provider, input.model)!;
        const result = await pi.compact(event.preparation, model, input.secret || 'tinygpt-local', undefined, [event.customInstructions, contextSettings.summaryInstructions].filter(Boolean).join('\n'), event.signal, 'off', (m, c, o) => requestStream(m, c, o, 'summary'), undefined, settings.getRetrySettings());
        const conversation = history.conversation(input.conversationId!);
        const requests = event.branchEntries.flatMap(entry => entry.type === 'message' && entry.message.role === 'user' ? [{ at: entry.timestamp, content: entry.message.content }] : []);
        const hostRequests = input.messages.filter(message => message.role === 'user').map(message => ({ id: message.id, text: message.text }));
        const state = await observations.save({ conversationId: input.conversationId!, runId: input.runId, tool: 'exact Work state', permission: 'read', workspace: directory,
          text: JSON.stringify({ requests, hostRequests, artifacts: history.codeChanges(input.conversationId!).filter(change => conversation.messages.some(message => message.runId === change.runId)).map(change => ({ id: change.id, path: change.path, state: change.state })), operations: conversation.tools.map(tool => ({ id: tool.id, name: tool.name, status: tool.status, target: tool.target })), questions: history.workTasks.questions().filter(question => question.conversationId === input.conversationId) }) });
        const current = input.messages.at(-1)?.text ?? '';
        const anchors = `\n\n## Exact host records\nCurrent user request: ${current.length <= Math.min(2000, policy.window * .02) ? JSON.stringify(current) : '(See saved requests.)'}\nExact user requests/corrections, artifact revisions, operation outcomes and questions: read_observation id=${state.id}. Use query to find exact text without reading every page. These are records, not permission grants. Retrieve details when needed rather than repeating a completed action.`;
        result.summary += anchors;
        if (result.estimatedTokensAfter !== undefined) result.estimatedTokensAfter += Math.ceil(anchors.length / 3);
        const inputTokens = (result.usage?.input ?? 0) + (result.usage?.cacheRead ?? 0) + (result.usage?.cacheWrite ?? 0);
        onContext?.({ type: 'usage', inputTokens, outputTokens: result.usage?.output ?? 0 });
        onTrace?.({ event: 'compaction-detail', runtime: 'pi', purpose: 'summary', inputTokens, outputTokens: result.usage?.output ?? 0, contextBeforeTokens: result.tokensBefore, ...(result.estimatedTokensAfter === undefined ? {} : { contextAfterTokens: result.estimatedTokensAfter }), retainedTokens: contextSettings.keepRecentTokens, budgetTokens: contextSettings.summaryOutputTokens });
        return result;
      };
      const loader = new pi.DefaultResourceLoader({ cwd: directory, agentDir, settingsManager: settings, noExtensions: true, extensionFactories: [workContextExtension(observations, input, directory, compact, onTrace)], noSkills: true, noPromptTemplates: true, noThemes: true, appendSystemPrompt: [input.instructions, ...(input.instructions.includes(INCREMENTAL_WORK_INSTRUCTIONS) ? [] : [INCREMENTAL_WORK_INSTRUCTIONS]), ...(stableTools ? [STABLE_WORK_TOOL_INSTRUCTIONS] : [])] });
      await loader.reload();
      const shellEnv = await codeShellEnvironment(root);
      const spawnHook: import('@earendil-works/pi-coding-agent').BashSpawnHook = context => {
        const env = { ...context.env, ...shellEnv }; if (process.platform === 'win32') delete env.Path;
        return { ...context, ...(process.platform === 'win32' ? { command: "$ErrorActionPreference = 'Stop'\n" + bundledNodePowerShell() + '\n' + context.command + '\nif ($LASTEXITCODE) { exit $LASTEXITCODE }' } : {}), env };
      };
      const shell = process.platform === 'win32' ? pi.createPowerShellToolDefinition(directory, { spawnHook }) : pi.createBashToolDefinition(directory, { spawnHook });
      const definitions = [pi.createReadToolDefinition(directory), pi.createWriteToolDefinition(directory), pi.createEditToolDefinition(directory), pi.createLsToolDefinition(directory), pi.createFindToolDefinition(directory), pi.createGrepToolDefinition(directory), shell] as unknown as PiTool[];
      const tools: PiTool[] = definitions.map(definition => ({
        ...definition,
        ...(definition.name === 'read' ? { description: 'Read a contiguous text-file page in the workspace, up to 2,000 lines or 50 KiB. offset is a 1-based line number; limit is a line count. The returned page is not shortened again. Follow the returned next offset for remaining lines; use a narrower offset/limit to inspect a specific section. Images are not supported by this file reader. For an image reference or image file, load_tools group:images query:view_image, then call view_image with image set to the exact reference or relative file path. Browser tools also include view_image when image inspection is supported.' } : {}),
        async execute(callID, args: any, toolSignal, update, context) {
          if (definition.name === 'read' && typeof args.path === 'string' && args.path.startsWith('tinygpt-image:')) throw new Error('This is an image reference, not a file path. Use load_tools with group:"images", query:"view_image", then view_image with image set to this exact reference. Do not capture another screenshot or search Project files.');
          const id = randomUUID(); const name: NativeCodeToolName = ({ read: 'code_read', write: 'code_write', edit: 'code_edit', ls: 'code_read', find: 'code_glob', grep: 'code_grep', powershell: 'code_bash', bash: 'code_bash' } as Record<string, NativeCodeToolName>)[definition.name];
          const mapped = ['read', 'write', 'edit', 'ls'].includes(definition.name) ? { ...args, filePath: args.path ?? directory, oldString: args.oldText, newString: args.newText } : ['powershell', 'bash'].includes(definition.name) ? { ...args, workdir: directory, description: args.command.slice(0, 100) } : args;
          recovery.assertAvailable(); assertWorkEditSize(name, mapped);
          await onNativeCode({ phase: 'before', id, name, args: mapped });
          try {
            const result = await (definition as PiTool).execute(callID, args, toolSignal, update, context);
            let text = result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
            const firstChangedLine = (result.details as { firstChangedLine?: number } | undefined)?.firstChangedLine;
            if (definition.name === 'edit' && typeof firstChangedLine === 'number') text += `\nFirst changed line: ${firstChangedLine}`;
            const shellResult = result.structuredContent as { exit_code?: number } | undefined;
            const observed = await onNativeCode({ phase: 'after', id, status: (result as { isError?: boolean }).isError ? 'error' : 'success', output: text, ...(typeof shellResult?.exit_code === 'number' ? { metadata: { exit: shellResult.exit_code } } : {}) });
            const authorized = observed.output ?? text;
            if (result.content.every(part => part.type === 'text')) {
              // Native read already returns a bounded, contiguous line page and
              // its continuation offset. A second head/tail excerpt hides the
              // middle of that page and mixes character offsets with line numbers.
              const record = definition.name !== 'read' && authorized.length > 6000 ? await observations.save({ conversationId: input.conversationId!, runId: input.runId, tool: definition.name, text: authorized, permission: 'read', workspace: directory, paths: typeof mapped.filePath === 'string' ? [mapped.filePath] : undefined }) : undefined;
              result.content = [{ type: 'text', text: record ? observations.excerpt(record) : authorized }];
            }
            return result;
          } catch (error) { await onNativeCode({ phase: 'after', id, status: 'error', output: error instanceof Error ? error.message : String(error) }); throw error; }
        },
      }));
      const shared = [...toolDefinitions.filter(tool => !replacedTools.has(tool.name) && (tool.name !== "view_image" || input.imageTools || input.vision)), ...simpleWorkToolDefinitions.filter(tool => ['work_plan', 'work_ask_user', 'work_history'].includes(tool.name)), ...(input.extensionTools ?? [])].map(withoutToolMetadata);
      const catalog = new WorkToolCatalog(shared);
      const schemaTokens = (text: string) => Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
      const schemaBudget = Math.max(schemaTokens(JSON.stringify([...catalog.available(), ...(stableTools ? [invokeWorkTool] : [])])), Math.min(10000, Math.floor(policy.inputTokens * .25)));
      const surface = stableTools ? new StableWorkTools(shared, schemaBudget, schemaTokens) : undefined;
      let session: import('@earendil-works/pi-coding-agent').AgentSession;
      const nativeNames = tools.map(tool => tool.name);
      const activeNames = () => [...nativeNames, 'code_task', ...(surface ? [...surface.direct.map(tool => tool.name), invokeWorkTool.name] : catalog.available().map(tool => tool.name))];
      const executeShared = async (definition: typeof shared[number], args: any) => {
        signal.throwIfAborted();
        if (surface) {
          if (definition.name === 'load_tools' && args.group !== 'services') return { content: [{ type: 'text' as const, text: JSON.stringify({ ...surface.discover(args.group, args.query), tools: activeNames() }) }], details: undefined };
          const result = await onTool({ id: randomUUID(), name: definition.name as import('../shared/tools').ToolName, input: args });
          let value: any; try { value = JSON.parse(result); } catch { /* Plain results remain intact. */ }
          if (value?.error) throw new Error(result);
          return { content: [{ type: 'text' as const, text: definition.name === 'load_tools' && value ? JSON.stringify(surface.serviceResult(value)) : result }], details: undefined };
        }
        return undefined;
      };
      tools.push(...shared.map(definition => ({
        name: definition.name, label: definition.name, description: surface?.direct.find(tool => tool.name === definition.name)?.description ?? definition.description, parameters: definition.schema as PiTool['parameters'],
        async execute(_callID: string, args: any) {
          if (surface) {
            if (!surface.direct.some(tool => tool.name === definition.name)) throw new Error('Use load_tools and invoke_tool for this action. Nothing was executed.');
            return (await executeShared(definition, args))!;
          }
          if (!catalog.has(definition.name)) throw new Error('Load the relevant tools before calling this action. Nothing was executed.');
          if (definition.name === 'load_tools' && args.group !== 'services') {
            const issue = catalog.selectionIssue(args.group, args.query, schemaBudget, schemaTokens);
            if (issue) throw new Error(JSON.stringify(issue));
            catalog.enable(args.group, args.query); session.setActiveToolsByName(activeNames());
            const actual = session.getActiveToolNames();
            onTrace?.({ event: 'tools-activated', runtime: 'pi', toolNames: actual });
            const missing = activeNames().filter(name => !actual.includes(name));
            if (missing.length) throw new Error(`These tools could not be activated: ${missing.join(', ')}.`);
            return { content: [{ type: 'text' as const, text: JSON.stringify({ tools: actual, guide: catalog.guide() }) }], details: undefined };
          }
          const result = await onTool({ id: randomUUID(), name: definition.name as import('../shared/tools').ToolName, input: args });
          let value: any; try { value = JSON.parse(result); } catch { /* Plain tool results are also valid. */ }
          if (value?.error) throw new Error(result);
          if (definition.name === 'load_tools' && value?.enabled === 'services' && Array.isArray(value.toolNames)) {
            const issue = catalog.selectionIssue('services', args.query, schemaBudget, schemaTokens, value.toolNames);
            if (issue) throw new Error(JSON.stringify(issue));
            catalog.enable('services', args.query, value.toolNames); session.setActiveToolsByName(activeNames());
            onTrace?.({ event: 'tools-activated', runtime: 'pi', toolNames: session.getActiveToolNames() });
          }
          return { content: [{ type: 'text' as const, text: result }], details: undefined };
        },
      })));
      if (surface) tools.push({ name: invokeWorkTool.name, label: 'Additional action', description: invokeWorkTool.description, parameters: invokeWorkTool.schema as PiTool['parameters'],
        async execute(_callID, args: any) { return (await executeShared(surface.resolve(args) as typeof shared[number], args.input))!; },
      });
      let coding = false;
      let resumeCodingSession: string | undefined;
      tools.push({ name: 'code_task', label: 'Coding agent', description: 'Delegate substantial coding, debugging or testing using the selected model. Pass the goal and paths. Set browser:true only when the task needs browser UI, console or network verification; browser tools are otherwise omitted. Returns its answer and sessionId; reuse that ID to continue.', parameters: { type: 'object', properties: { task: { type: 'string', minLength: 1, maxLength: 16000 }, sessionId: { type: 'string' }, browser: { type: 'boolean', description: 'Enable isolated Chrome DevTools for browser verification. Does not grant browser permission.' } }, required: ['task'], additionalProperties: false } as PiTool['parameters'],
        async execute(_callID, args: any, toolSignal, update) {
          if (coding) throw new Error('A coding task is already running. Wait for its result before starting another.');
          coding = true; const id = randomUUID(); let admitted = false;
          try {
            await onNativeCode({ phase: 'before', id, name: 'code_delegate', args }); admitted = true;
            const progress = { text: '', reasoning: '' };
            const parts = new Map<string, { text: string; omitted: number }>();
            const result = await runCodeTask({ input, root: join(root, 'opencode'), directory, task: args.task, sessionId: args.sessionId ?? resumeCodingSession, browser: args.browser === true, signal: toolSignal ? AbortSignal.any([signal, toolSignal]) : signal, native: event => onNativeCode(event.phase === 'before' ? { ...event, agentId: id } : event), trace: onTrace, preparingTool: () => onResponse?.({ type: "preparing-tool" }), checkBrowserAccess: () => { checkBrowserAccess?.(); if (fileDestination(history, input.conversationId!).root !== directory) throw new Error('The Project folder changed. Select it again.'); }, progress: (text, kind, partId, startedAt) => {
              progress[kind] = workDisplayTail(progress[kind] + text);
              const part = parts.get(partId) ?? { text: '', omitted: 0 };
              const combined = part.text + text;
              part.text = workDisplayTail(combined); part.omitted += combined.length - part.text.length;
              parts.set(partId, part);
              onResponse?.({ type: 'work-part', id: `coding-${id}-${partId}`, agentId: id, startedAt, kind: kind === 'text' ? 'prose' : 'reasoning', text: part.text, omittedCharacters: part.omitted });
              if (kind === 'reasoning') onReasoning?.(text);
              update?.({ content: [{ type: 'text', text: progress.text.slice(-8000) }], details: undefined });
            } });
            const text = JSON.stringify(result); await onNativeCode({ phase: 'after', id, status: 'success', output: text });
            resumeCodingSession = undefined;
            return { content: [{ type: 'text', text }], details: { codingRecovery: null } };
          } catch (error) {
            if (error instanceof WorkOutputLimitError) {
              resumeCodingSession = error.details.sessionId;
              recovery.failed('opencode', revision());
              const text = JSON.stringify({ error: error.details, recovery: 'Resume this sessionId; inspect saved files and make the next complete change smaller. Do not start over. This task is incomplete.' });
              if (admitted) await onNativeCode({ phase: 'after', id, status: 'error', output: text });
              return { content: [{ type: 'text', text }], isError: true, details: { codingRecovery: { sessionId: resumeCodingSession, directory } } };
            }
            if (admitted) await onNativeCode({ phase: 'after', id, status: 'error', output: error instanceof Error ? error.message : String(error) }); throw error;
          }
          finally { coding = false; }
        },
      });
      // Pi's tools option is a registration allowlist, not the initial visible selection.
      const created = await pi.createAgentSession({ cwd: directory, agentDir, modelRuntime: runtime, model: runtime.getModel(provider, input.model)!, thinkingLevel: input.effort === 'instant' ? 'off' : input.effort === 'max' ? 'high' : input.effort ?? 'medium', tools: tools.map(tool => tool.name), customTools: tools, sessionManager: manager, settingsManager: settings, resourceLoader: loader });
      session = created.session;
      // Recovery metadata travels with the selected native branch. Do not read
      // another conversation's latest session or replay a completed delegation.
      for (const message of [...session.messages].reverse()) {
        if (message.role !== 'toolResult' || message.toolName !== 'code_task') continue;
        const saved = (message.details as { codingRecovery?: { sessionId?: string; directory?: string } } | undefined)?.codingRecovery;
        if (saved?.directory === directory && typeof saved.sessionId === 'string') resumeCodingSession = saved.sessionId;
        break;
      }
      const compactionBudget = settings.getCompactionSettings(session.model);
      onTrace?.({ event: 'context-budget', runtime: 'pi', budgetTokens: session.model?.contextWindow ?? policy.window, outputTokens: policy.outputTokens, retainedTokens: compactionBudget.keepRecentTokens });
      session.setActiveToolsByName(activeNames());
      onTrace?.({ event: 'tools-activated', runtime: 'pi', toolNames: session.getActiveToolNames() });
      const messageId = input.replyMessageId ?? input.workTask?.messageId;
      if (messageId && session.sessionFile) await writeFile(join(pointers, `${messageId}.json`), JSON.stringify({ file: session.sessionFile, cwd: directory }), { mode: 0o600 });
      onTrace?.({ event: 'runtime-ready', runtime: 'pi', runtimeVersion: '1.5.0' });
      let turn = 0, textStarted = false, firstText = false, firstThinking = false, finalParts: string[] = [], compactionId: string | undefined;
      const parts = new Map<string, { text: string; omittedCharacters: number }>();
      let callbackError: unknown;
      const unsubscribe = session.subscribe(event => {
        try {
        if (event.type === 'message_start' && event.message.role === 'assistant') { turn++; textStarted = false; finalParts = []; parts.clear(); }
        if (event.type === 'message_update') {
          const update = event.assistantMessageEvent;
          if (update.type === 'text_delta' || update.type === 'thinking_delta') {
            const kind = update.type === 'text_delta' ? 'prose' : 'reasoning', id = `pi-${turn}-${update.contentIndex}`;
            const previous = parts.get(id), combined = (previous?.text ?? '') + update.delta;
            const text = workDisplayTail(combined), omittedCharacters = (previous?.omittedCharacters ?? 0) + combined.length - text.length;
            parts.set(id, { text, omittedCharacters });
            // Pi does not distinguish commentary from a final answer in text
            // deltas. Keep it in the chain until the native run confirms its end.
            if (kind === 'prose') { if (!firstText) { firstText = true; onTrace?.({ event: 'first-text' }); } if (!textStarted) { textStarted = true; onResponse?.({ type: 'start', lane: 'progress' }); } if (!finalParts.includes(id)) finalParts.push(id); onDelta(update.delta); }
            else { if (!firstThinking) { firstThinking = true; onTrace?.({ event: 'first-thinking' }); } onReasoning?.(update.delta); }
            onResponse?.({ type: 'work-part', id, kind, text, omittedCharacters });
          } else if (update.type === 'toolcall_start') onResponse?.({ type: 'preparing-tool' });
        }
        if (event.type === 'tool_execution_start') onResponse?.({ type: 'tool' });
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          if (event.message.stopReason === 'length') {
            recovery.failed('pi', revision());
            onTrace?.({ event: 'output-continuation', runtime: 'pi', phase: event.message.content.some(part => part.type === 'toolCall') ? 'tool-input' : event.message.content.some(part => part.type === 'text') ? 'answer' : 'thinking', outputTokens: event.message.usage.output, outcome: 'interrupted' });
          }
          const usage = event.message.usage;
          onContext?.({ type: 'usage', inputTokens: usage.input + usage.cacheRead + usage.cacheWrite, outputTokens: usage.output });
          onTrace?.({ event: 'model-usage', runtime: 'pi', purpose: 'reply', inputTokens: usage.input + usage.cacheRead + usage.cacheWrite, outputTokens: usage.output, cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite, contextBeforeTokens: session.getContextUsage()?.tokens ?? 0 });
        }
        if (event.type === 'compaction_start') { compactionId = randomUUID(); onContext?.({ type: 'optimizing', id: compactionId }); }
        if (event.type === 'compaction_end' && compactionId) { const contextAfterTokens = session.getContextUsage()?.tokens ?? manager!.buildSessionProjection().messages.reduce((sum, message) => sum + pi.estimateTokens(message), 0); onTrace?.({ event: 'context-measure-end', runtime: 'pi', purpose: 'summary', contextAfterTokens }); onContext?.({ type: event.errorMessage || event.aborted ? 'optimization-failed' : 'optimized', id: compactionId }); compactionId = undefined; }
        } catch (error) {
          // Pi can turn listener exceptions into a provider-shaped error message.
          // Preserve the host failure for the service's existing safe error filter.
          callbackError ??= error;
          throw error;
        }
      });
      const abort = () => { void session.abort(); };
      signal.addEventListener('abort', abort, { once: true });
      let steeringError: unknown;
      let steeringFlight = Promise.resolve();
      const deliver = () => { steeringFlight = steeringFlight.then(async () => { for (const item of steering?.pending() ?? []) { await session.steer(item.text); steering?.consume([item.id]); } }).catch(error => { steeringError = error; void session.abort(); }); };
      const unsubscribeSteering = steering?.subscribe(deliver);
      try {
        signal.throwIfAborted();
        const last = input.messages.at(-1);
        await session.prompt(last?.text ?? input.workTask?.goal ?? 'Continue the saved task.').catch(error => { recovery.assertAvailable(); throw callbackError ?? error; });
        recovery.assertAvailable();
        if (callbackError) throw callbackError;
        await steeringFlight; if (steeringError) throw steeringError;
        signal.throwIfAborted();
        const final = [...session.messages].reverse().find(message => message.role === 'assistant');
        if (final?.role === 'assistant') {
          if (final.stopReason === 'length') throw new Error(final.content.some(part => part.type === 'toolCall') ? TOOL_OUTPUT_LIMIT_MESSAGE : OUTPUT_LIMIT_MESSAGE);
          if (final.stopReason === 'error' || final.stopReason === 'aborted') throw new Error(chatError(final.errorMessage ?? 'The model stopped without a final answer.'));
        }
        const answerText = final?.role === 'assistant' ? final.content.filter(part => part.type === 'text').map(part => part.text).join('\n\n') : undefined;
        onResponse?.({ type: 'work-complete', answerPartIds: finalParts, answerText }); onResponse?.({ type: 'end' }); onTrace?.({ event: 'worker-complete' });
      } finally { unsubscribeSteering?.(); signal.removeEventListener('abort', abort); await session.abort(); unsubscribe(); session.dispose(); }
    },
  };
}
