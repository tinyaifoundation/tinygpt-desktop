import { WORK_RUNTIME_INSTRUCTIONS } from '../shared/work-runtimes';
import { Agent } from 'undici';
import { createServer, type IncomingMessage } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ChatWorkerInput } from '../shared/chat';
import type { NativeCodeCallback } from '../shared/code';
import { nativeCodeToolNameSchema } from '../shared/tools';
import type { TraceEvent } from '../shared/diagnostics';
import { contextPolicy } from '../core/context';
import { workEffortPayload } from '../core/work-effort';
import { workRequestPayload } from '../core/work-request';
import { assertWorkEditSize, INCREMENTAL_WORK_INSTRUCTIONS, WorkOutputLimitError, workToolPayload } from '../core/work-limits';
import { workOutputBudget } from '../core/work-history-import';
import { openRouterPayload } from '../core/openrouter-policy';
import { scopedFetch } from '../core/librechat';
import { providerActivityFetch } from '../core/provider-activity';
import { CodeStream } from '../core/code-stream';
import { codeBinary } from './code-execution';
import { codeShellEnvironment, bundledNodePowerShell } from './code-shell';
import { DEVTOOLS_PREFIX, devtoolsMcpConfig } from './devtools-mcp';
import { serveBrowserPreview } from './browser-preview';
import { builtInModelId } from '../shared/managed-local';

async function jsonBody(request: IncomingMessage) {
  const parts: Buffer[] = []; let size = 0;
  for await (const part of request) { size += part.length; if (size > 4_000_000) throw new Error('Request too large.'); parts.push(part); }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

/** Only transport, approval and display hooks. OpenCode owns its prompts and loop. */
function nativePlugin(url: string, token: string, shellEnv: Record<string, string>, commandPrefix: string) {
  return `
const post = async value => { const r = await fetch(${JSON.stringify(url)}, {method:'POST',headers:{authorization:${JSON.stringify(`Bearer ${token}`)},'content-type':'application/json'},body:JSON.stringify(value)}); const result=await r.json(); if(!r.ok)throw Error(result.error||'Action unavailable'); return result; };
export default async () => {
  if(process.platform==='win32') {
    const {createRequire,syncBuiltinESMExports}=await import('node:module'); const cp=createRequire(process.execPath)('node:child_process'); const spawn=cp.spawn;
    cp.spawn=function(command,args,options){return Array.isArray(args)?spawn.call(this,command,args,{...options,windowsHide:true}):spawn.call(this,command,{...options,...args,windowsHide:true});}; syncBuiltinESMExports();
  }
  await post({phase:'ready'});
  return {
    'shell.env':async(_input,output)=>{Object.assign(output.env,${JSON.stringify(shellEnv)});if(process.platform==='win32')delete output.env.Path;},
    'tool.execute.before':async(input,output)=>{const browser=input.tool.startsWith(${JSON.stringify(DEVTOOLS_PREFIX)});if(!browser&&!['read','glob','grep','edit','write','bash','apply_patch','todowrite'].includes(input.tool))throw Error('Use the available coding tools.'); await post({phase:'before',callID:input.callID,tool:browser?'devtools':input.tool,args:browser?{tool:input.tool.slice(${DEVTOOLS_PREFIX.length}),input:output.args}:output.args}); if(input.tool==='bash' && ${JSON.stringify(commandPrefix)} && typeof output.args.command==='string')output.args.command=${JSON.stringify(commandPrefix + '\n')}+output.args.command+${JSON.stringify('\nif ($LASTEXITCODE) { exit $LASTEXITCODE }')};},
    'tool.execute.after':async(input,output)=>{if(input.tool.startsWith(${JSON.stringify(DEVTOOLS_PREFIX)}))return; const result=await post({phase:'after',callID:input.callID,status:'success',output:output.output,metadata:output.metadata}); if(typeof result.output==='string')output.output=result.output;}
  };
};`;
}

export interface CodeTaskOptions {
  input: ChatWorkerInput; root: string; directory: string; task: string; sessionId?: string; browser?: boolean;
  signal: AbortSignal; native: NativeCodeCallback; trace?: (event: TraceEvent) => void;
  progress?: (text: string, kind: 'text' | 'reasoning', partId: string, startedAt?: number) => void;
  checkBrowserAccess?: () => void;
  preparingTool?: () => void;
}

/** Persistent upstream sessions; no TinyGPT context reconstruction or completion policy. */
export async function runCodeTask(options: CodeTaskOptions) {
  const { input, root, directory, signal, native, trace } = options;
  await mkdir(root, { recursive: true });
  const token = randomBytes(32).toString('hex'), password = randomBytes(32).toString('hex');
  const policy = contextPolicy(input), pending = new Map<string, string>();
  // OpenCode's family detection uses substring matches. "tinygpt-pro" is not
  // a GPT model; keep branding out of its internal provider/model identifier.
  const builtIn = builtInModelId(input.model), codingModel = builtIn ? `local-${builtIn}` : input.model;
  const completions = new Set<Promise<unknown>>();
  const lifecycle = new AbortController(), runningSignal = AbortSignal.any([signal, lifecycle.signal]);
  let bridgeReady = false;
  const transport = scopedFetch(input.endpoint, providerActivityFetch(fetch, () => {}, event => trace?.({ ...event, purpose: undefined, runtime: 'opencode' })));
  const complete = async (callID: string, status: 'success' | 'error', output: string, metadata?: Record<string, unknown>) => {
    const id = pending.get(callID); if (!id) return {};
    pending.delete(callID); return native({ phase: 'after', id, status, output, metadata });
  };
  const gateway = createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== `Bearer ${token}` || request.method !== 'POST') { response.writeHead(403).end(); return; }
      const url = request.url ?? '';
      if (url === '/native') {
        const event = await jsonBody(request); let result = {};
        if (event.phase === 'ready') { bridgeReady = true; }
        else if (event.phase === 'before') {
          const name = nativeCodeToolNameSchema.parse(`code_${event.tool}`), id = randomUUID();
          if (typeof event.callID !== 'string' || !event.args || typeof event.args !== 'object') throw new Error('Invalid action.');
          assertWorkEditSize(name, event.args);
          await native({ phase: 'before', id, name, args: event.args }); pending.set(event.callID, id);
        } else if (event.phase === 'after') result = await complete(event.callID, event.status, String(event.output ?? ''), event.metadata);
        else throw new Error('Invalid action phase.');
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result)); return;
      }
      if (!['/v1/chat/completions', '/v1/responses', '/v1/messages'].includes(url)) { response.writeHead(404).end(); return; }
      let payload = await jsonBody(request);
      if (payload.model !== codingModel) { response.writeHead(403).end(); return; }
      payload.model = input.model;
      payload = workToolPayload(payload);
      payload = workEffortPayload(payload, input, workOutputBudget(payload, policy.outputTokens));
      if (input.provider === 'openrouter') payload = openRouterPayload(payload, input);
      payload = workRequestPayload(payload, input);
      for (const field of ['max_tokens', 'max_completion_tokens', 'max_output_tokens']) if (typeof payload[field] === 'number') payload[field] = Math.min(payload[field], policy.outputTokens);
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (input.protocol === 'anthropic') { headers['x-api-key'] = input.secret ?? ''; headers['anthropic-version'] = '2023-06-01'; }
      else headers.authorization = `Bearer ${input.secret || 'tinygpt-local'}`;
      const upstream = await transport(`${input.endpoint.replace(/\/$/, '')}${url.slice(3)}`, { method: 'POST', headers, body: JSON.stringify(payload), signal: runningSignal });
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
      if (upstream.body) for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
        if (response.destroyed) break;
        if (!response.write(chunk)) await new Promise<void>(resolve => { response.once('drain', resolve); response.once('close', resolve); });
      }
      response.end();
    } catch (error) { if (!response.headersSent) response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Action failed.' })); }
  });
  await new Promise<void>((resolve, reject) => { gateway.once('error', reject); gateway.listen(0, '127.0.0.1', resolve); });
  const gatewayUrl = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
  const plugin = join(root, `bridge-${input.runId}.mjs`);
  const sdkTransport = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
  let child: ChildProcess | undefined;
  let client: ReturnType<typeof import('@opencode-ai/sdk/v2')['createOpencodeClient']> | undefined;
  let sessionID: string | undefined;
  let preview: Awaited<ReturnType<typeof serveBrowserPreview>> | undefined;
  try {
    const shellEnv = await codeShellEnvironment(root);
    const npmConfig = join(root, '.npmrc');
    await writeFile(npmConfig, 'offline=true\nregistry=http://127.0.0.1:9\nfetch-retries=0\n', { mode: 0o600 });
    await writeFile(plugin, nativePlugin(`${gatewayUrl}/native`, token, shellEnv, process.platform === 'win32' ? "$ErrorActionPreference = 'Stop'\n" + bundledNodePowerShell() : ''), { mode: 0o600 });
    let browserAllowed = true;
    try { options.checkBrowserAccess?.(); } catch { browserAllowed = false; }
    const devtools = options.browser === true && browserAllowed ? devtoolsMcpConfig(root, directory) : undefined;
    const config = {
      autoupdate: false, share: 'disabled', logLevel: 'ERROR', plugin: [pathToFileURL(plugin).href],
      enabled_providers: ['tinygpt'], model: `tinygpt/${codingModel}`, small_model: `tinygpt/${codingModel}`,
      provider: { tinygpt: { npm: input.protocol === 'anthropic' ? '@ai-sdk/anthropic' : input.protocol === 'openai-responses' ? '@ai-sdk/openai' : '@ai-sdk/openai-compatible', options: { baseURL: `${gatewayUrl}/v1`, apiKey: token }, models: { [codingModel]: { id: codingModel, name: input.model, tool_call: true, limit: { context: policy.window, output: policy.outputTokens }, interleaved: { field: 'reasoning_content' } } } } },
      mcp: { ...(devtools ? { chrome_devtools: devtools } : {}) },
      permission: { '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', edit: 'allow', bash: 'allow', todowrite: 'allow', external_directory: 'allow', 'chrome_devtools_*': 'allow' },
      tools: { '*': false, read: true, glob: true, grep: true, write: true, edit: true, bash: true, apply_patch: true, todowrite: true, 'chrome_devtools_*': !!devtools },
      ...(process.platform === 'win32' ? { shell: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') } : {}),
    };
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key];
    Object.assign(env, shellEnv, { NPM_CONFIG_USERCONFIG: npmConfig, npm_config_userconfig: npmConfig, NPM_CONFIG_OFFLINE: 'true', npm_config_offline: 'true', NPM_CONFIG_REGISTRY: 'http://127.0.0.1:9', npm_config_registry: 'http://127.0.0.1:9', HOME: root, USERPROFILE: root, APPDATA: join(root, 'config'), LOCALAPPDATA: join(root, 'cache'), XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'), OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_SERVER_PASSWORD: password, OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_DISABLE_CLAUDE_CODE: 'true', OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true' });
    delete env.Path;
    child = spawn(codeBinary(), ['serve', '--hostname=127.0.0.1', '--port=0'], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const url = await new Promise<string>((resolve, reject) => {
      let text = ''; const timer = setTimeout(() => finish(new Error('The coding agent took too long to start.')), 30000);
      const abort = () => finish(new Error('Cancelled.'));
      const finish = (error?: Error, url?: string) => { clearTimeout(timer); runningSignal.removeEventListener('abort', abort); child?.stdout?.removeListener('data', data); error ? reject(error) : resolve(url!); };
      const data = (chunk: Buffer) => { text = (text + chunk.toString()).slice(-4000); const match = /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(text); if (match) finish(undefined, match[1]); };
      child!.stdout!.on('data', data); child!.once('error', error => finish(error)); child!.once('exit', () => finish(new Error('The coding agent could not start.'))); runningSignal.addEventListener('abort', abort, { once: true }); if (runningSignal.aborted) abort();
    });
    const { createOpencodeClient } = await import('@opencode-ai/sdk/v2');
    client = createOpencodeClient({ fetch: request => fetch(request, { dispatcher: sdkTransport } as RequestInit), baseUrl: url, headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` }, throwOnError: true });
    const earlyEvents = await client.global.event({ signal: runningSignal });
    const startupErrors: string[] = [];
    const earlyListener = (async () => { for await (const event of earlyEvents.stream) if (event.payload.type === 'session.error') startupErrors.push(JSON.stringify(event.payload.properties.error)); })(); void earlyListener.catch(() => {});
    if (options.sessionId) {
      const previous = await client.session.get({ sessionID: options.sessionId, directory }, { signal: runningSignal });
      if (previous.data?.directory !== directory) throw new Error('The coding session belongs to another folder.');
      sessionID = options.sessionId;
    } else sessionID = (await client.session.create({ directory, title: 'TinyGPT coding task' }, { signal: runningSignal })).data!.id;
    if (!bridgeReady) throw new Error(`The coding agent could not connect its tools. ${startupErrors.join('; ')}`);
    let browserContext = options.browser === true ? 'Chrome DevTools MCP is unavailable because Chrome or Chromium is not installed.' : 'Browser tools were not requested for this coding task. Use file and command verification; the parent can resume with browser:true if browser verification becomes necessary.';
    if (!browserAllowed) browserContext = 'Browser verification is disabled by the user\'s current tool preferences. Report that limitation; do not bypass it.';
    if (config.mcp.chrome_devtools && browserAllowed) {
      const state = await client.mcp.status({ directory }, { signal: runningSignal });
      if (state.data?.chrome_devtools?.status !== 'connected') throw new Error('Chrome DevTools MCP could not start: ' + JSON.stringify(state.data?.chrome_devtools));
      preview = await serveBrowserPreview(directory, 'index.html', () => { runningSignal.throwIfAborted(); options.checkBrowserAccess?.(); }, true);
      browserContext = `Chrome DevTools MCP is connected. For static HTML, the workspace is served at ${preview.url}; open that URL after creating index.html. Use its native console/network tools and browser interactions to diagnose and verify the app. For a development server, open its loopback URL. This browser is isolated from the TinyGPT desktop UI.`;
    }
    const requestedAt = Date.now(), metered = new Set<string>();
    const stream = new CodeStream(sessionID, (id, type, delta, startedAt) => {
      // Reconciliation includes saved history when a coding session resumes.
      // Only newly generated parts belong in this invocation's visible section.
      if (startedAt === undefined || startedAt >= requestedAt) options.progress?.(delta, type, id, startedAt);
    }, () => {}, part => {
      if (!['completed', 'error'].includes(part.state.status)) return;
      const state = part.state;
      const done = complete(part.callID, state.status === 'completed' ? 'success' : 'error', state.status === 'completed' ? state.output : state.status === 'error' ? state.error : '', state.status === 'completed' ? state.metadata : undefined);
      completions.add(done); void done.finally(() => completions.delete(done)).catch(() => {});
    }, undefined, undefined, part => { if (stream.lastAssistant?.id === part.messageID && stream.lastAssistant.time.created >= requestedAt) options.preparingTool?.(); });
    const meter = (info: import('@opencode-ai/sdk/v2').Message) => {
      if (info.role !== 'assistant' || !info.time.completed || info.time.created < requestedAt || metered.has(info.id)) return;
      metered.add(info.id);
      trace?.({ event: 'delegated-usage', runtime: 'opencode', purpose: info.summary ? 'summary' : 'reply', inputTokens: info.tokens.input + info.tokens.cache.read + info.tokens.cache.write, outputTokens: info.tokens.output + info.tokens.reasoning, cacheReadTokens: info.tokens.cache.read, cacheWriteTokens: info.tokens.cache.write });
    };
    const events = await client.event.subscribe({ directory }, { signal: runningSignal });
    const listener = (async () => { for await (const event of events.stream) {
      stream.event(event);
      if (event.type === 'message.updated') meter(event.properties.info);
    } })(); void listener.catch(() => {});
    // OpenCode owns completion, including tool steps and compaction continuations.
    const result = await client.session.prompt({ directory, sessionID, agent: 'build', system: 'Your role in user-facing progress and results is Coding agent.\n' + WORK_RUNTIME_INSTRUCTIONS + '\n' + INCREMENTAL_WORK_INSTRUCTIONS, model: { providerID: 'tinygpt', modelID: codingModel }, parts: [{ type: 'text', text: options.task + '\n\n' + browserContext }] }, { signal: runningSignal });
    if (!result.data) throw new Error('The coding agent returned no completed response.');
    const messages = await client.session.messages({ directory, sessionID }, { signal: runningSignal });
    for (const message of messages.data ?? []) {
      stream.message(message.info); meter(message.info);
      for (const part of message.parts) stream.part(part);
    }
    stream.message(result.data.info); meter(result.data.info);
    for (const part of result.data.parts) stream.part(part);
    await Promise.all([...completions]); stream.assertFinished();
    const answer = result.data.parts.filter(part => part.type === 'text').map(part => part.text).join('\n');
    return { sessionId: sessionID, answer: answer.slice(0, 24000), truncated: answer.length > 24000 };
  } catch (error) {
    if (error instanceof WorkOutputLimitError) trace?.({ event: 'output-continuation', runtime: 'opencode', phase: error.details.stage, outputTokens: error.details.outputTokens, outcome: 'interrupted' });
    throw error;
  } finally {
    if (client && sessionID && signal.aborted) await client.session.abort({ directory, sessionID }, { signal: AbortSignal.timeout(2000) }).catch(() => {});
    if (client) await client.instance.dispose({ directory }, { signal: AbortSignal.timeout(5000) }).catch(() => {});
    lifecycle.abort();
    await sdkTransport.destroy();
    await preview?.close();
    if (child && child.exitCode === null) { const exited = new Promise(resolve => child!.once('exit', resolve)); child.kill(); await Promise.race([exited, delay(3000)]); if (child.exitCode === null) child.kill('SIGKILL'); }
    await Promise.allSettled([...completions]);
    for (const callID of pending.keys()) await complete(callID, 'error', 'Interrupted. Inspect saved changes before continuing.').catch(() => {});
    gateway.closeAllConnections(); await new Promise<void>(resolve => gateway.close(() => resolve())); await unlink(plugin).catch(() => {});
  }
}
