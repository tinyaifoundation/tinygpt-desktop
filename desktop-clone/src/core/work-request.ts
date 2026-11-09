import type { ChatWorkerInput } from '../shared/chat';
import type { TraceEvent } from '../shared/diagnostics';
import { createHash } from 'node:crypto';

/** Native llama.cpp options only; cloud/unknown compatible APIs keep their contract. */
export function workRequestPayload(payload: Record<string, unknown>, input: Pick<ChatWorkerInput, 'provider' | 'protocol' | 'reasoning'>) {
  return input.provider === 'local' && input.protocol === 'openai-compatible' && input.reasoning?.kind === 'llamacpp'
    ? { ...payload, cache_prompt: true, return_progress: true }
    : payload;
}

/** Character counts describe payload composition, not tokenizer counts or cache hits.
 * Keep no message text between requests, only per-message digests. */
export function requestComposition(payload: Record<string, any>) {
  const chars = { system: 0, user: 0, reasoning: 0, assistant: 0, toolResults: 0, toolArguments: 0, schemas: JSON.stringify(payload.tools ?? []).length };
  for (const message of payload.messages ?? []) {
    const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
    if (message.role === 'system' || message.role === 'developer') chars.system += text.length;
    else if (message.role === 'user') chars.user += text.length;
    else if (message.role === 'tool') chars.toolResults += text.length;
    else if (message.role === 'assistant') { chars.assistant += text.length; chars.reasoning += (message.reasoning_content ?? message.reasoning ?? '').length; chars.toolArguments += JSON.stringify(message.tool_calls ?? []).length; }
  }
  return chars;
}

export function workRequestAudit() {
  let previous: string[] = [], schemas: string | undefined;
  const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return (payload: Record<string, any>): TraceEvent => {
    const messages = (payload.messages ?? []).map(digest), currentSchemas = digest(payload.tools ?? []);
    let stablePrefixMessages = 0;
    while (stablePrefixMessages < Math.min(messages.length, previous.length) && messages[stablePrefixMessages] === previous[stablePrefixMessages]) stablePrefixMessages++;
    const event: TraceEvent = { event: 'request-shape', promptCharacters: requestComposition(payload), messageCount: messages.length, stablePrefixMessages, ...(schemas === undefined ? {} : { schemasChanged: schemas !== currentSchemas }) };
    previous = messages; schemas = currentSchemas;
    return event;
  };
}

/** Inspect bounded SSE lines for native numeric counters only. No token text,
 * URLs, headers or arbitrary response metadata cross into diagnostics. */
export function promptProgressObserver(trace: (event: TraceEvent) => void, clock = Date.now) {
  const decoder = new TextDecoder(); let pending = '', last = -Infinity;
  return (chunk: Uint8Array) => {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split('\n'); pending = lines.pop()!.slice(-16384);
    for (const line of lines) {
      if (!line.startsWith('data: ') || line.length > 16384) continue;
      let progress: any; try { progress = JSON.parse(line.slice(6)).prompt_progress; } catch { continue; }
      if (!progress || !['total', 'cache', 'processed', 'time_ms'].every(key => Number.isSafeInteger(progress[key]) && progress[key] >= 0 && progress[key] <= 100000000)) continue;
      if (progress.cache > progress.total || progress.processed > progress.total) continue;
      const now = clock(); if (now - last < 5000 && progress.processed < progress.total) continue;
      last = now;
      trace({ event: 'prompt-progress', inputTokens: progress.total, cacheReadTokens: progress.cache, promptProcessedTokens: Math.max(0, progress.processed - progress.cache), promptProcessingMs: progress.time_ms });
    }
  };
}
