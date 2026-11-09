import { WORK_RUNTIME_INSTRUCTIONS } from '../shared/work-runtimes';
import { isComputerTool } from '../shared/computer';
import { app } from 'electron';
import { createServer, type IncomingMessage } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, appendFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { imageMcpContent, visionTool } from '../shared/vision';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ChatExecution } from '../shared/chat';
import { OUTPUT_LIMIT_MESSAGE, isOutputLimitMessage, COMPACTION_OUTPUT_LIMIT_MESSAGE } from '../shared/chat';
import { toolDefinitions, nativeCodeToolNameSchema, type ToolName } from '../shared/tools';
import { separateToolDisplay, toolApprovalText, toolStatusSchema, approvalTextSchema } from '../shared/tool-display';
import { CODE_RUNTIME_ERROR } from '../shared/code';
import { contextPolicy, prepareConversationContext, CHECKPOINT_INSTRUCTIONS } from '../core/context';
import { measureChatContext, chatExecution } from './chat-execution';
import { FIRST_RESPONSE_TIMEOUT_MS, REPLY_IDLE_TIMEOUT_MS, REPLY_TIMEOUT_MESSAGE } from '../shared/chat-timeouts';
import { scopedFetch } from '../core/librechat';
import { providerActivityFetch } from '../core/provider-activity';
import { openRouterStreamFetch } from '../core/openrouter-stream';
import { chatError } from '../core/chat-errors';
import { CodeStream, codePrompt, codeProviderPayload } from '../core/code-stream';
import { effortPayload } from '../core/effort';
import { openRouterPayload } from '../core/openrouter-policy';
import { EFFORT_BUDGET_MESSAGE } from '../shared/effort';
import { codePlugin } from './code-plugin';
import { scopedPath } from './files';
import { codeShellEnvironment } from './code-shell';
import { setTimeout as delay } from 'node:timers/promises';
import { SkillContext } from '../core/skill-context';

export function codeBinary(): string {
  const packageName = `opencode-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
  const require = createRequire(__filename);
  if (process.arch === 'x64') { try { return require.resolve(`${packageName}-baseline/bin/opencode${process.platform === 'win32' ? '.exe' : ''}`).replace('app.asar', 'app.asar.unpacked'); } catch { /* The platform package remains the fallback. */ } }
  return require.resolve(`${packageName}/bin/opencode${process.platform === 'win32' ? '.exe' : ''}`).replace('app.asar', 'app.asar.unpacked');
}
async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of request) { length += chunk.length; if (length > 2_000_000) throw new Error('Request too large.'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const finished = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill();
  await Promise.race([finished, new Promise<void>(resolve => setTimeout(resolve, 3000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

export const codeExecution: ChatExecution = {
  async run(input, userSignal, onDelta, onTool, onReasoning, onResponse, onContext, onTrace, onNativeCode, steering) {
    const deadline = new AbortController(); const signal = AbortSignal.any([userSignal,deadline.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pendingTools = 0;
    const activity = (timeout = REPLY_IDLE_TIMEOUT_MS) => { clearTimeout(timer); if (!pendingTools) timer = setTimeout(() => deadline.abort(),timeout); };
    signal.throwIfAborted();
    input = { ...input, contextWindowTokens: Math.min(input.contextWindowTokens ?? (input.route === 'local' ? 8192 : 32768),64000) };
    const skills = new SkillContext(text => Math.ceil(text.length / 3), Math.max(512, Math.floor(contextPolicy(input).inputTokens * 0.35)));
    const token = randomBytes(32).toString('hex'); const password = randomBytes(32).toString('hex');
    // Optional fixture budget only. Interactive coding has no step/request cap.
    const configuredLimit = Number(process.env.TINYGPT_CODE_REQUEST_LIMIT);
    const requestLimit = Number.isSafeInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : Infinity;
    // Each running agent owns its configuration, bootstrap files and upstream
    // database. Concurrent processes must not rewrite one another's runtime.
    const runtimeRoot = join(app.getPath('userData'), 'code-runtime');
    const root = join(runtimeRoot, 'runs', input.runId);
    // Native tools operate in the selected Project. Runtime configuration and
    // trusted plugins remain private; repository plugins/config are disabled.
    const directory = await scopedPath(input.projectRoot ?? null,'.');
    if (!onNativeCode) throw new Error(CODE_RUNTIME_ERROR);
    await mkdir(root, { recursive: true });
    // Upstream attempts an unused plugin-SDK bootstrap even with plugins off.
    // Keep that installer offline; our providers and MCP bridge are bundled.
    const npmConfig = join(root,'.npmrc');
    await writeFile(npmConfig,'offline=true\nregistry=http://127.0.0.1:9\nfetch-retries=0\n',{mode:0o600});
    const replaced = new Set(['write_project_file','read_project_file','list_project_files','create_project_directory','edit_project_file','run_project_command']);
    const definitions = input.tools ? [...toolDefinitions.filter(tool => !isComputerTool(tool.name) && tool.name !== 'present' && !replaced.has(tool.name) && (input.vision === true || input.imageTools === true || !visionTool(tool.name))), ...(input.extensionTools ?? []).map(tool => ({ ...tool, schema: { ...tool.schema, properties: { ...(tool.schema.properties as Record<string,unknown> ?? {}), __tinygpt_status: toolStatusSchema, __tinygpt_approval: approvalTextSchema } } }))] : [];
    const transports = new Set<StreamableHTTPServerTransport>();
    let providerFailure: Error | undefined; let requests = 0;
    let pluginReady = false;
    const nativeActions = new Map<string,string>();
    const nativeCompletions = new Set<Promise<unknown>>();
    const finishNative = async (callID: string, status: 'success'|'error', output: string, metadata?: Record<string,unknown>) => {
      const id = nativeActions.get(callID); if (!id) return {};
      nativeActions.delete(callID);
      try { return await onNativeCode({phase:'after',id,status,output,metadata}); }
      finally { pendingTools--; activity(FIRST_RESPONSE_TIMEOUT_MS); }
    };
    const transportFetch = providerActivityFetch(scopedFetch(input.endpoint), event => activity(event === 'data' ? REPLY_IDLE_TIMEOUT_MS : FIRST_RESPONSE_TIMEOUT_MS), onTrace);
    const providerFetch = input.provider === 'openrouter' && input.protocol === 'openai-compatible' ? openRouterStreamFetch(transportFetch, () => onResponse?.({ type: 'preparing-tool' })) : transportFetch;
    const gateway = createServer(async (request, response) => {
      if (signal.aborted) { response.writeHead(410).end(); return; }
      const authorized = request.headers.authorization === `Bearer ${token}` || request.url?.startsWith('/provider/') && input.protocol === 'anthropic' && request.headers['x-api-key'] === token;
      if (!authorized || request.headers.origin) { response.writeHead(403).end(); return; }
      try {
        if (request.url === '/native' && request.method === 'POST') {
          const event = await body(request) as Record<string,unknown>;
          if (event.phase === 'ready') { pluginReady = true; response.writeHead(200,{'content-type':'application/json'}).end('{}'); return; }
          if (typeof event.callID !== 'string' || event.callID.length > 200) throw new Error('Invalid native action.');
          let result = {};
          if (event.phase === 'before') {
            const name = nativeCodeToolNameSchema.parse(`code_${event.tool}`);
            if (!event.args || typeof event.args !== 'object' || Array.isArray(event.args) || nativeActions.has(event.callID)) throw new Error('Invalid native action.');
            const id = randomUUID(); pendingTools++; clearTimeout(timer);
            try {
              onResponse?.({type:'tool'});
              await onNativeCode({phase:'before',id,name,args:event.args as Record<string,unknown>,displayText:typeof event.displayText === 'string' ? event.displayText.slice(0,48) : undefined,approvalText:toolApprovalText(event.approvalText)});
              nativeActions.set(event.callID,id);
            } catch(error) {
              pendingTools--; activity(FIRST_RESPONSE_TIMEOUT_MS);
              response.writeHead(403,{'content-type':'application/json'}).end(JSON.stringify({error:error instanceof Error ? error.message : 'This action could not be approved.'})); return;
            }
          } else if (event.phase === 'after') result = await finishNative(event.callID,'success',typeof event.output === 'string' ? event.output : '',event.metadata as Record<string,unknown>);
          else throw new Error('Invalid native action.');
          response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(result)); return;
        }
        if (request.url === '/mcp' && request.method === 'POST') {
          const server = new Server({ name: 'TinyGPT Code tools', version: '0.1.0' }, { capabilities: { tools: {} } });
          server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.schema as { type: 'object' } })) }));
          server.setRequestHandler(CallToolRequestSchema, async call => {
            const definition = definitions.find(tool => tool.name === call.params.name);
            if (!definition || !onTool) throw new Error('Undeclared tool.');
            signal.throwIfAborted(); onResponse?.({ type: 'tool' });
            const args = call.params.arguments ?? {};
            const display = definition.name.startsWith('ext_') ? (() => { const { __tinygpt_status, __tinygpt_approval, ...input } = args; return { input, displayText: typeof __tinygpt_status === 'string' ? __tinygpt_status.slice(0,48) : undefined, approvalText: toolApprovalText(__tinygpt_approval) }; })() : separateToolDisplay(args);
            pendingTools++; clearTimeout(timer);
            let result: string; try { result = await onTool({ id: randomUUID(), name: definition.name as ToolName, ...display }); skills.remember(definition.name, result); } finally { pendingTools--; activity(FIRST_RESPONSE_TIMEOUT_MS); }
            return { content: imageMcpContent(definition.name, result) };
          });
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); transports.add(transport);
          response.once('close', () => { transports.delete(transport); void server.close(); });
          await server.connect(transport); await transport.handleRequest(request, response, await body(request)); return;
        }
        const path = request.url?.replace(/^\/provider/, '');
        const allowed = input.protocol === 'anthropic' ? '/v1/messages' : input.protocol === 'openai-responses' ? '/v1/responses' : '/v1/chat/completions';
        if (request.method !== 'POST' || path !== allowed || ++requests > requestLimit) { response.writeHead(403).end(); return; }
        const nativePayload = codeProviderPayload(await body(request) as Record<string, unknown>,input.provider,input.model);
        const payload = skills.restore(openRouterPayload(effortPayload(nativePayload, input, contextPolicy(input).outputTokens), input));
        if (payload.model !== input.model) { response.writeHead(403).end(); return; }
        const policy = contextPolicy(input);
        for (const field of ['max_tokens','max_completion_tokens','max_output_tokens']) if (typeof payload[field] === 'number') payload[field] = Math.min(payload[field] as number, policy.outputTokens);
        const headers: Record<string,string> = { 'content-type': 'application/json' };
        if (input.protocol === 'anthropic') { headers['x-api-key'] = input.secret ?? ''; headers['anthropic-version'] = '2023-06-01'; }
        else headers.authorization = `Bearer ${input.secret || 'tinygpt-local'}`;
        const suffix = allowed.replace(/^\/v1/, '');
        const endpoint = input.endpoint.replace(/\/$/,'');
        const destination = input.protocol === 'anthropic' ? `${endpoint.replace(/\/v1$/,'')}${allowed}` : `${endpoint}${suffix}`;
        const upstream = await providerFetch(destination, { method: 'POST', headers, body: JSON.stringify(payload), signal, redirect: 'error' });
        if (!upstream.ok) providerFailure = new Error(chatError({ status: upstream.status }));
        response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
        if (upstream.body) { const reader = upstream.body.getReader(); try { while (true) { const { value, done } = await reader.read(); if (done) break; signal.throwIfAborted(); if (!response.write(value)) await new Promise<void>(resolve => { const done = () => { response.removeListener('drain',done); response.removeListener('close',done); resolve(); }; response.once('drain',done); response.once('close',done); }); if (response.destroyed) break; } } finally { await reader.cancel().catch(() => {}); } }
        response.end();
      } catch (error) {
        if (error instanceof Error && error.message === EFFORT_BUDGET_MESSAGE) providerFailure = error;
        if (!response.headersSent) response.writeHead(502); response.end();
      }
    });
    await new Promise<void>((resolve, reject) => { gateway.once('error', reject); gateway.listen(0, '127.0.0.1', resolve); });
    const gatewayPort = (gateway.address() as { port: number }).port;
    const baseURL = `http://127.0.0.1:${gatewayPort}/provider/v1`;
    const shellEnv = await codeShellEnvironment(root);
    const pluginPath = join(root,`bridge-${input.runId}.mjs`);
    await writeFile(pluginPath,codePlugin(`http://127.0.0.1:${gatewayPort}/native`,token,shellEnv),{mode:0o600});
    const policy = contextPolicy(input);
    const config = {
      logLevel: 'ERROR', autoupdate: false, share: 'disabled', snapshot: false, lsp: false, formatter: false, plugin: [pathToFileURL(pluginPath).href],
      enabled_providers: ['tinygpt'], model: `tinygpt/${input.model}`, small_model: `tinygpt/${input.model}`, default_agent: 'build',
      ...(process.platform === 'win32' ? {shell:join(process.env.SystemRoot ?? 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe')} : {}),
      provider: { tinygpt: { npm: input.protocol === 'anthropic' ? '@ai-sdk/anthropic' : input.protocol === 'openai-responses' ? '@ai-sdk/openai' : '@ai-sdk/openai-compatible', name: 'TinyGPT connection', options: { baseURL, apiKey: token, timeout: 600000 }, models: { [input.model]: { id: input.model, name: 'Selected connection', tool_call: input.tools, attachment: input.vision === true, modalities: { input: input.vision === true ? ['text','image'] : ['text'], output: ['text'] }, limit: { context: Math.min(policy.window, 64000), output: policy.outputTokens }, interleaved: { field: 'reasoning_content' } } } } },
      // The authenticated native hook checks canonical file paths and handles
      // approvals before execution. Upstream's heuristic external-directory
      // check also matches approved shell arguments/cache paths; don't apply a
      // second, blanket denial after TinyGPT has authorized the action.
      permission: { '*': 'deny', read:'allow',glob:'allow',grep:'allow',edit:'allow',write:'allow',bash:'allow',apply_patch:'allow',todowrite:'allow',external_directory:'allow','tinygpt_*': 'allow' },
      tools: { '*': false,read:true,glob:true,grep:true,edit:true,write:true,bash:true,apply_patch:true,todowrite:true,'tinygpt_*': true },
      // User-message system fields disappear from native auto-compaction
      // continuations. Agent configuration survives every model request,
      // including compaction and steering, without changing the tool policy.
      agent: { build: { prompt: input.instructions }, title: { disable: true }, summary: { disable: true } },
      mcp: { tinygpt: { type: 'remote', url: `http://127.0.0.1:${gatewayPort}/mcp`, headers: { Authorization: `Bearer ${token}` }, oauth: false, enabled: true, timeout: 86400000 } },
      compaction: { auto: true, prune: true }, watcher: { ignore: ['**'] },
    };
    const env: NodeJS.ProcessEnv = {};
    for (const name of ['PATH','Path','SystemRoot','WINDIR','TEMP','TMP','PATHEXT']) if (process.env[name]) env[name] = process.env[name];
    Object.assign(env, shellEnv, { NPM_CONFIG_USERCONFIG: npmConfig, npm_config_userconfig: npmConfig, NPM_CONFIG_OFFLINE: 'true', npm_config_offline: 'true', NPM_CONFIG_REGISTRY: 'http://127.0.0.1:9', npm_config_registry: 'http://127.0.0.1:9', HOME: root, USERPROFILE: root, APPDATA: join(root,'config'), LOCALAPPDATA: join(root,'cache'), XDG_CONFIG_HOME: join(root,'config'), XDG_DATA_HOME: join(root,'data'), XDG_CACHE_HOME: join(root,'cache'), XDG_STATE_HOME: join(root,'state'), OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_SERVER_PASSWORD: password, OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_DISABLE_CLAUDE_CODE: 'true', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: 'true', OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true' });
    delete env.Path;
    let child: ChildProcess | undefined;
    const lifecycle = new AbortController(); const runtimeSignal = AbortSignal.any([signal, lifecycle.signal]);
    let client: Awaited<ReturnType<typeof import('@opencode-ai/sdk/v2')['createOpencodeClient']>> | undefined;
    let sessionID: string | undefined; let emittedPart: string | undefined;
    let unsubscribeSteering: (() => void) | undefined;
    let steeringFlight: Promise<void> | undefined;
    let steeringFailure: unknown;
    let latestSteeringID: string | undefined;
    try {
      signal.throwIfAborted(); activity(FIRST_RESPONSE_TIMEOUT_MS);
      child = spawn(codeBinary(), ['serve','--hostname=127.0.0.1','--port=0'], { cwd: directory, env, windowsHide: true, stdio: ['ignore','pipe','ignore'] });
      const url = await new Promise<string>((resolve,reject) => {
        let text = ''; const timer = setTimeout(() => reject(new Error(CODE_RUNTIME_ERROR)),30000);
        const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
        const abort = () => { cleanup(); reject(new Error('Cancelled.')); }; signal.addEventListener('abort', abort, { once: true });
        child!.once('error', () => { cleanup(); reject(new Error(CODE_RUNTIME_ERROR)); }); child!.once('exit', () => { cleanup(); reject(new Error(CODE_RUNTIME_ERROR)); });
        child!.stdout!.on('data', bytes => { text = (text + bytes.toString()).slice(-4000); const match = /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(text); if (match) { cleanup(); resolve(match[1]); } });
        if (signal.aborted) abort();
      });
      onTrace?.({ event: 'worker-ready' });
      const { createOpencodeClient } = await import('@opencode-ai/sdk/v2');
      client = createOpencodeClient({ baseUrl: url, headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` }, throwOnError: true });
      onTrace?.({ event: 'runtime-ready' });
      const texts = [input.instructions + JSON.stringify(definitions), ...input.messages.map(message => message.text)];
      const measured = await measureChatContext(input.model,texts,signal);
      onTrace?.({ event: 'tokenizer-ready' });
      const fixedTokens = measured[0] + 2500;
      onTrace?.({ event: 'context-budget', budgetTokens: policy.inputTokens, fixedTokens });
      const prepared = await prepareConversationContext(input,text => Buffer.byteLength(text,'utf8'),fixedTokens,signal,async (transcript,prior) => {
        let text = '';
        await chatExecution.run({ ...input, runId: randomUUID(), purpose: 'summary', tools: false, checkpoint: undefined, instructions: `${CHECKPOINT_INSTRUCTIONS}\nKeep this checkpoint under 1000 characters.`, messages: [{ role:'user',text:`${prior ? `Earlier checkpoint:\n${prior}\n\n` : ''}${transcript}` }] },signal,delta => { text += delta; },undefined,undefined,undefined,event => { if (event.type === 'usage') onContext?.(event); },onTrace);
        return text;
      },onContext,message => measured[input.messages.indexOf(message)+1]+8+(message.images?.length??0)*8192);
      const created = await client.session.create({ title: 'TinyGPT Code', directory }, { signal: runtimeSignal }); sessionID = created.data!.id;
      if (!pluginReady) throw new Error(CODE_RUNTIME_ERROR);
      await appendFile(join(runtimeRoot,'sessions.jsonl'), JSON.stringify({ runId: input.runId, conversationId: input.conversationId, sessionID, createdAt: Date.now() })+'\n', { mode: 0o600 });
      const events = await client.event.subscribe({ directory }, { signal: runtimeSignal });
      let firstText = false; let firstThinking = false;
      const stream = new CodeStream(sessionID,(id,type,delta) => {
        if (type === 'reasoning') { if (!firstThinking) { firstThinking = true; onTrace?.({event:'first-thinking'}); } onReasoning?.(delta); return; }
        if (emittedPart !== id) { emittedPart = id; onResponse?.({type:'start',lane:'unclassified'}); }
        if (!firstText) { firstText = true; onTrace?.({event:'first-text'}); } onDelta(delta);
      },(inputTokens,outputTokens) => onContext?.({type:'usage',inputTokens,outputTokens}),part => {
        if (!nativeActions.has(part.callID)) return;
        const state = part.state;
        if (state.status !== 'completed' && state.status !== 'error') return;
        const completion = finishNative(part.callID,state.status === 'completed' ? 'success' : 'error',state.status === 'completed' ? state.output : state.error,state.metadata);
        nativeCompletions.add(completion); void completion.finally(() => nativeCompletions.delete(completion)).catch(() => {});
      },part => {
        const id = nativeActions.get(part.callID);
        if (id && part.tool === 'bash' && part.state.status === 'running' && typeof part.state.metadata?.output === 'string') {
          void onNativeCode({phase:'output',id,output:part.state.metadata.output}).catch(() => {});
        }
      }, part => onResponse?.({ type: 'work-part', id: part.id, kind: part.type === 'text' ? 'prose' : 'reasoning', text: part.text, startedAt: part.time?.start }));
      let sessionFailed = false;
      const listener = (async () => {
        for await (const event of events.stream) {
          if (runtimeSignal.aborted) break;
          if (event.type === 'session.error' && event.properties.sessionID === sessionID) sessionFailed = true;
          stream.event(event);
        }
      })();
      void listener.catch(() => { if (!runtimeSignal.aborted) onTrace?.({event:'request-error',failure:'runtime',runtimeCause:'event-stream'}); });
      // A fresh upstream session per turn keeps edited/regenerated branches and
      // changed inference credentials isolated. Native saved history is authoritative.
      const images = prepared.messages.flatMap(message => (message.images ?? []).map(url => ({ type:'file' as const, mime: /^data:([^;]+);/.exec(url)?.[1] ?? 'image/png', url })));
      // The synchronous prompt endpoint holds its HTTP response for the whole
      // run. Node's transport can time out its headers at five minutes even
      // while the agent is healthy. Dispatch once, then observe short requests.
      await client.session.promptAsync({ sessionID, directory, model: { providerID: 'tinygpt', modelID: input.model }, agent: 'build', system: WORK_RUNTIME_INSTRUCTIONS, parts: [...codePrompt(prepared.messages,prepared.summary), ...images] }, { signal: runtimeSignal });
      const deliverSteering = () => {
        if (steeringFlight || !steering || runtimeSignal.aborted) return;
        steeringFlight = (async () => {
          for (const item of steering.pending()) {
            runtimeSignal.throwIfAborted();
            const messageID = `msg_${Date.now().toString(16).padStart(12, '0')}${randomBytes(6).toString('hex')}`;
            latestSteeringID = messageID;
            await client!.session.promptAsync({ sessionID: sessionID!, directory, messageID, model: { providerID: 'tinygpt', modelID: input.model }, agent: 'build', parts: [{ type: 'text', text: item.text }, ...(item.images ?? []).map(url => ({ type: 'file' as const, mime: /^data:([^;]+);/.exec(url)?.[1] ?? 'image/png', url }))] }, { signal: runtimeSignal });
            steering.consume([item.id]);
          }
        })().catch(error => { steeringFailure = error; }).finally(() => { steeringFlight = undefined; if (!steeringFailure && steering.pending().length) deliverSteering(); });
      };
      unsubscribeSteering = steering?.subscribe(deliverSteering); deliverSteering();
      while (true) {
        runtimeSignal.throwIfAborted();
        if (steeringFailure) throw steeringFailure;
        if (child.exitCode !== null || child.signalCode !== null) { onTrace?.({event:'request-error',failure:'runtime',runtimeCause:'child-exit'}); throw new Error(CODE_RUNTIME_ERROR); }
        const status = await client.session.status({directory},{signal:AbortSignal.any([runtimeSignal,AbortSignal.timeout(10000)])});
        const saved = await client.session.messages({sessionID,directory},{signal:AbortSignal.any([runtimeSignal,AbortSignal.timeout(10000)])});
        for (const message of saved.data ?? []) { stream.message(message.info); for (const part of message.parts) stream.part(part); }
        if (sessionFailed) { stream.assertFinished(); throw new Error(CODE_RUNTIME_ERROR); }
        // A newly dispatched session may still appear idle before its first
        // assistant message. Never mistake that race for a completed reply.
        if ((!status.data?.[sessionID] || status.data[sessionID].type === 'idle') && stream.lastAssistant && !steeringFlight && !steering?.pending().length && (!latestSteeringID || stream.lastAssistant.parentID === latestSteeringID)) {
          await Promise.all([...nativeCompletions]);
          try { stream.assertFinished(); } catch(error) { onTrace?.({event:'request-error',failure:'runtime',runtimeCause:'incomplete-session'}); throw error; }
          break;
        }
        await delay(750,undefined,{signal:runtimeSignal});
      }
      // Reconcile final saved parts before stopping SSE. This is read-only and
      // also captures usage/outcomes when their last stream event arrives late.
      const saved = await client.session.messages({sessionID,directory},{signal:runtimeSignal});
      for (const message of saved.data ?? []) { stream.message(message.info); for (const part of message.parts) stream.part(part); }
      await Promise.all([...nativeCompletions]);
      stream.assertFinished();
      onResponse?.({ type: 'work-complete', answerPartIds: stream.finalTextPartIds() });
      onResponse?.({ type: 'end' }); onTrace?.({ event: 'worker-complete' });
    } catch (error) {
      if (userSignal.aborted) throw new Error('Cancelled.');
      if (deadline.signal.aborted) throw new Error(REPLY_TIMEOUT_MESSAGE);
      const recoverable = error instanceof Error && (isOutputLimitMessage(error.message) || error.message === COMPACTION_OUTPUT_LIMIT_MESSAGE || /conversation capacity|conversation optimization|Project instructions or tool definitions/i.test(error.message));
      if (!providerFailure && !recoverable) onTrace?.({event:'worker-stopped',failure:'runtime',runtimeCause:child && (child.exitCode !== null || child.signalCode !== null) ? 'child-exit' : 'transport'});
      throw providerFailure ?? (recoverable ? error : new Error(CODE_RUNTIME_ERROR));
    }
    finally {
      unsubscribeSteering?.();
      clearTimeout(timer);
      lifecycle.abort();
      await steeringFlight;
      if (sessionID && client && signal.aborted) await client.session.abort({ sessionID, directory }, { signal: AbortSignal.timeout(2000) }).catch(() => {});
      if (child) await stop(child);
      await Promise.allSettled([...nativeCompletions]);
      // The child has stopped, so read-only reconciliation can capture files
      // saved just before cancellation even if its final hook never arrived.
      for (const callID of [...nativeActions.keys()]) await finishNative(callID,'error','The coding action was interrupted. Inspect saved changes before continuing.').catch(() => {});
      clearTimeout(timer);
      await unlink(pluginPath).catch(() => {});
      for (const transport of transports) await transport.close().catch(() => {});
      gateway.closeAllConnections(); await new Promise<void>(resolve => gateway.close(() => resolve()));
    }
  },
};
