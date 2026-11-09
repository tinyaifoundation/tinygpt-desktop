import { utilityProcess } from 'electron';
import { join } from 'node:path';
import type { ChatExecution, ChatWorkerEvent } from '../shared/chat';
import { workToolNames } from '../shared/work';
import { toolNameSchema } from '../shared/tools';
import { idSchema } from '../shared/chat';
import { FIRST_RESPONSE_TIMEOUT_MS, REPLY_IDLE_TIMEOUT_MS, REPLY_TIMEOUT_MESSAGE } from '../shared/chat-timeouts';
import { traceEventSchema, type TraceEvent } from '../shared/diagnostics';
import { CHAT_UI_MAX_CHARACTERS, validateChatUI } from '../shared/generative-ui';

type Worker = ReturnType<typeof utilityProcess.fork>;
type Pool = { idle: Entry[]; limit: number; model?: string; retries: number; retry?: ReturnType<typeof setTimeout> };
type Entry = { worker: Worker; ready: boolean; encodings: Set<string>; warming?: string; pool: Pool };
const foreground: Pool = { idle: [], limit: 2, retries: 0 };
const metadata: Pool = { idle: [], limit: 1, retries: 0 };
const workers = new Map<Worker, Entry>();
// Match the SDK's encodingForModel, retaining the SDK's exact token counter.
const encoding = (model: string) => model.toLowerCase().includes('claude') ? 'claude' : 'o200k_base';
function warm(entry: Entry): void {
  const model = entry.pool.model;
  if (!entry.ready || model === undefined || entry.warming || entry.encodings.has(encoding(model))) return;
  entry.warming = model; entry.worker.postMessage({ type: 'warm', model });
}
function retain(entry: Entry): void {
  const { worker, pool } = entry; worker.removeAllListeners(); pool.idle.push(entry);
  worker.on('message', (event: ChatWorkerEvent) => {
    if (event.type === 'ready') { entry.ready = true; warm(entry); }
    if (event.type === 'warmed') { entry.encodings.add(encoding(event.model)); entry.warming = undefined; pool.retries = 0; warm(entry); }
    if (event.type === 'failed') lost();
  });
  function lost() {
    if (!workers.has(worker)) return;
    discard(worker, false);
    // Avoid an unbounded restart loop if the installation itself is broken.
    if (pool.model !== undefined && pool.retries++ < 3 && !pool.retry) pool.retry = setTimeout(() => { pool.retry = undefined; refill(pool); }, 1000);
  }
  worker.once('exit', lost); warm(entry);
}
function discard(worker: Worker, replace = true): void {
  const entry = workers.get(worker); if (!entry) return;
  workers.delete(worker); const index = entry.pool.idle.indexOf(entry); if (index >= 0) entry.pool.idle.splice(index, 1);
  worker.removeAllListeners(); worker.kill(); if (replace) refill(entry.pool);
}
function release(worker: Worker, model: string): void {
  const entry = workers.get(worker); if (!entry) return;
  entry.ready = true; entry.warming = undefined; entry.encodings.add(encoding(model));
  if (entry.pool.idle.length >= entry.pool.limit) {
    const cold = entry.pool.idle.find(other => !other.ready || other.warming || !other.encodings.has(encoding(model)));
    if (cold) discard(cold.worker, false); else { discard(worker); return; }
  }
  retain(entry); refill(entry.pool);
}
function acquire(model: string, pool = foreground): Entry {
  // A ready process can still be compiling its tokenizer. Prefer a warmed lease.
  let index = pool.idle.findIndex(entry => entry.ready && !entry.warming && entry.encodings.has(encoding(model)));
  if (index < 0) index = pool.idle.findIndex(entry => entry.ready);
  if (index < 0) index = pool.idle.length ? 0 : -1;
  const entry = index >= 0 ? pool.idle.splice(index, 1)[0] : createWorker(pool);
  entry.worker.removeAllListeners(); refill(pool); return entry;
}
function createWorker(pool: Pool): Entry {
  const env = { ...process.env, LANGCHAIN_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false', LANGSMITH_TRACING: 'false' };
  for (const key of Object.keys(env)) if (/^(LANGFUSE|LANGSMITH|LANGCHAIN_API|OPENAI_API_KEY|ANTHROPIC_API_KEY)/.test(key)) delete env[key as keyof typeof env];
  const worker = utilityProcess.fork(join(__dirname, 'chat-worker.js'), [], { env, stdio: 'ignore', serviceName: pool === metadata ? 'TinyGPT Titles' : 'TinyGPT Chat' });
  const entry: Entry = { worker, pool, ready: false, encodings: new Set() }; workers.set(worker, entry); return entry;
}
function refill(pool: Pool): void {
  if (pool.model === undefined || pool.retry || pool.retries > 3) return;
  // Active leases count toward the reserve. Otherwise every short reply would
  // spawn a replacement only to discard it as soon as the reply completed.
  while ([...workers.values()].filter(entry => entry.pool === pool).length < pool.limit) retain(createWorker(pool));
}
export function warmChatRuntime(model: string): void {
  foreground.model = model; foreground.retries = 0;
  for (const entry of foreground.idle) warm(entry);
  refill(foreground);
}
export function closeChatRuntime(): void {
  for (const pool of [foreground, metadata]) { pool.model = undefined; clearTimeout(pool.retry); pool.retry = undefined; pool.retries = 0; }
  for (const worker of workers.keys()) discard(worker, false);
}
export function measureChatContext(model: string, texts: string[], signal: AbortSignal): Promise<number[]> {
  return new Promise((resolve,reject) => {
    const { worker, ready } = acquire(model);
    let settled = false;
    const finish = (counts?: number[]) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort',abort); if (counts) { release(worker, model); resolve(counts); } else { discard(worker); reject(new Error(signal.aborted ? 'Cancelled.' : 'Conversation optimization could not finish. Your history is preserved; retry this reply.')); } };
    const abort = () => finish(); const timer = setTimeout(abort,45000); signal.addEventListener('abort',abort,{once:true});
    const send = () => worker.postMessage({ type:'measure',model,texts });
    worker.on('message',(event: ChatWorkerEvent) => { if (event.type === 'ready') send(); if (event.type === 'measured') { if (event.counts.length === texts.length && event.counts.every(count => Number.isSafeInteger(count) && count >= 0)) finish(event.counts); else finish(); } if (event.type === 'failed') finish(); });
    worker.once('exit',() => finish());
    if (signal.aborted) abort(); else if (ready) send();
  });
}

export const chatExecution: ChatExecution = {
  run(input, signal, onDelta, onTool, onReasoning, onResponse, onContext, onTrace, _onNativeCode, steering) {
    return new Promise<void>((resolve, reject) => {
      const { worker, ready } = acquire(input.model, input.purpose === 'metadata' ? metadata : foreground);
      let settled = false;
      let sent = false;
      const delivered = new Set<string>();
      const deliver = () => {
        if (!sent || settled) return;
        const items = steering?.pending().filter(item => !delivered.has(item.id)) ?? [];
        if (items.length) { items.forEach(item => delivered.add(item.id)); worker.postMessage({ type: 'steer', items }); }
      };
      const unsubscribeSteering = steering?.subscribe(deliver);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let toolCount = 0;
      const toolIds = new Set<string>();
      let requestId: string | undefined; let sawReasoning = false; let sawText = false; let textChars = 0; let reasoningChars = 0; let progressAt = Date.now();
      const trace = (event: TraceEvent) => { try { onTrace?.(event); } catch { /* Diagnostics cannot stop a reply. */ } };
      const progress = () => { if (Date.now() - progressAt > 5000) { trace({ event: 'model-progress', requestId, textChars, reasoningChars }); progressAt = Date.now(); } };
      function activity(timeout = REPLY_IDLE_TIMEOUT_MS) {
        clearTimeout(timer); timer = undefined;
        if (!settled && toolCount === 0) timer = setTimeout(() => finish(new Error(REPLY_TIMEOUT_MESSAGE)), timeout);
      }
      function finish(error?: Error) {
        if (settled) return;
        settled = true; unsubscribeSteering?.(); trace({ event: error ? 'worker-stopped' : 'worker-complete', textChars, reasoningChars }); clearTimeout(timer); signal.removeEventListener('abort', abort);
        if (error) discard(worker);
        else release(worker, input.model);
        if (error) reject(error); else resolve();
      }
      function abort() { finish(new Error('Cancelled.')); }
      signal.addEventListener('abort', abort, { once: true });
      activity(FIRST_RESPONSE_TIMEOUT_MS);
      worker.on('message', (event: ChatWorkerEvent) => {
        if (settled) return;
        if (event.type === 'ready' && !sent) { sent = true; trace({ event: 'worker-ready' }); activity(FIRST_RESPONSE_TIMEOUT_MS); worker.postMessage({ type: 'start', input }); deliver(); }
        if (event.type === 'steering-consumed') { try { steering?.consume(event.ids.filter(id => delivered.has(id))); } catch { finish(new Error('The chat runtime stopped unexpectedly. You can retry this reply.')); } }
        if (event.type === 'trace') {
          const parsed = traceEventSchema.safeParse(event.event);
          if (parsed.success) {
            if (parsed.data.event === 'request-start') { requestId = parsed.data.requestId; sawReasoning = false; sawText = false; }
            trace(parsed.data);
          }
        }
        if (event.type === 'activity' && ['request', 'response', 'data'].includes(event.activity)) {
          activity(event.activity === 'data' ? REPLY_IDLE_TIMEOUT_MS : FIRST_RESPONSE_TIMEOUT_MS);
        }
        if (event.type === 'tool-request') {
          const request = event.request;
          if (!idSchema.safeParse(request?.id).success || !(toolNameSchema.safeParse(request?.name).success || input.workTask && (workToolNames as readonly string[]).includes(request?.name) || input.extensionTools?.some(tool => tool.name === request?.name)) || !onTool || toolIds.has(request.id) || JSON.stringify(request.input ?? null).length > 120000) { finish(new Error('The chat runtime stopped unexpectedly. You can retry this reply.')); return; }
          toolIds.add(request.id); toolCount++; clearTimeout(timer);
          void onTool(request).then(result => { if (!settled && !signal.aborted) worker.postMessage({ type: 'tool-result', id: request.id, result }); }).catch(() => { if (!settled) worker.postMessage({ type: 'tool-result', id: request.id, result: JSON.stringify({ error: 'The tool was cancelled or could not finish.' }) }); }).finally(() => {
            toolCount--; if (!settled && toolCount === 0) activity(FIRST_RESPONSE_TIMEOUT_MS);
          });
        }
        if (event.type === 'delta' && typeof event.text === 'string') {
          if (event.text) { activity(); textChars += event.text.length; if (!sawText) { sawText = true; trace({ event: 'first-text', requestId }); } progress(); }
          try { onDelta(event.text); } catch { finish(new Error('The reply exceeded the supported size.')); }
        }
        if (event.type === 'reasoning' && typeof event.text === 'string') {
          if (event.text) { activity(); reasoningChars += event.text.length; if (!sawReasoning) { sawReasoning = true; trace({ event: 'first-thinking', requestId }); } progress(); }
          try { onReasoning?.(event.text); } catch { finish(new Error('The reply exceeded the supported size.')); }
        }
        if (event.type === 'response' && (['preparing-tool', 'tool', 'end'].includes(event.event?.type) || (event.event?.type === 'start' && ['progress', 'answer', 'unclassified'].includes(event.event.lane)))) { activity(); onResponse?.(event.event); }
        if (event.type === 'response' && event.event?.type === 'ui-preview') {
          const value = event.event;
          if (!idSchema.safeParse(value.id).success || input.mode === 'code' || input.mode === 'bot') return;
          try {
            if (value.ui !== null && JSON.stringify(value.ui).length > CHAT_UI_MAX_CHARACTERS) return;
            const ui = value.ui === null ? null : validateChatUI(value.ui);
            activity(); onResponse?.({ type: 'ui-preview', id: value.id, ui });
          } catch { /* Incomplete/invalid UI never crosses into executable tool input. */ }
        }
        if (event.type === 'response' && input.mode === 'code' && (event.event?.type === 'work-part' || event.event?.type === 'work-complete')) { activity(); onResponse?.(event.event); }
        if (event.type === 'context') {
          const value = event.event;
          const valid = value?.type === 'usage'
            ? Number.isSafeInteger(value.inputTokens) && value.inputTokens >= 0 && Number.isSafeInteger(value.outputTokens) && value.outputTokens >= 0
            : value && idSchema.safeParse(value.id).success && (['optimizing', 'optimized', 'optimization-failed'].includes(value.type) || value.type === 'checkpoint' && idSchema.safeParse(value.checkpoint?.throughMessageId).success && typeof value.checkpoint.text === 'string' && value.checkpoint.text.length <= 32000);
          if (!valid) { finish(new Error('The chat runtime stopped unexpectedly. You can retry this reply.')); return; }
          activity(); onContext?.(value);
        }
        if (event.type === 'complete') finish();
        if (event.type === 'failed') finish(new Error(event.message));
      });
      worker.on('exit', () => finish(new Error('The chat runtime stopped unexpectedly. You can retry this reply.')));
      if (ready) { sent = true; trace({ event: 'worker-ready' }); worker.postMessage({ type: 'start', input }); deliver(); }
      if (signal.aborted) abort();
    });
  },
};
