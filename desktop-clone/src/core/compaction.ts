import { COMPACTION_OUTPUT_LIMIT_MESSAGE } from '../shared/chat';
import { fadeToolResult } from './context';

// The SDK restores original tool results for self-compaction. Fade only their
// bulky evidence when needed; preserve messages, call IDs, and user text.
function fadeSummaryTools(body: Record<string, any>, limit: number): boolean {
  let changed = false;
  const fade = (text: unknown) => {
    if (typeof text !== 'string' || text.length <= limit) return text;
    changed = true; return fadeToolResult(text, limit);
  };
  const content = (value: unknown): unknown => Array.isArray(value) ? value.map(part => part?.type === 'text' ? { ...part, text: fade(part.text) } : part) : fade(value);
  body.messages = body.messages?.map((message: any) => message.role === 'tool' ? { ...message, content: content(message.content) }
    : Array.isArray(message.content) ? { ...message, content: message.content.map((part: any) => part?.type === 'tool_result' ? { ...part, content: content(part.content) } : part) } : message);
  body.input = Array.isArray(body.input) ? body.input.map((item: any) => item.type === 'function_call_output' ? { ...item, output: content(item.output) } : item) : body.input;
  return changed;
}

function outputLimit(frame: Record<string, any>): boolean {
  return Array.isArray(frame.choices) && frame.choices.some((choice: any) => choice?.finish_reason === 'length')
    || frame.delta?.stop_reason === 'max_tokens' || frame.stop_reason === 'max_tokens'
    || frame.response?.incomplete_details?.reason === 'max_output_tokens'
    || frame.incomplete_details?.reason === 'max_output_tokens';
}

/** Hold checkpoint responses until their terminal event has been checked. A
 * truncated checkpoint must never reach the SDK's summary commit path. Only
 * summary requests may be retried; ordinary model/tool requests pass through. */
export function compactionFetch(
  request: typeof fetch,
  active: () => boolean,
  budget: { outputTokens: number; window: number; retainedTokens?: number },
  count: (text: string) => number,
  failedUsage?: (inputTokens: number, outputTokens: number) => void,
): typeof fetch {
  return async (resource, options) => {
    if (!active() || typeof options?.body !== 'string') return request(resource, options);
    const body = JSON.parse(options.body) as Record<string, any>;
    const key = ['max_completion_tokens', 'max_output_tokens', 'max_tokens'].find(key => key in body);
    if (!key) return request(resource, options);
    // Counting the serialized messages/tools plus message overhead is a
    // conservative estimate; reserve extra room for the provider's framing.
    const promptCost = () => count(JSON.stringify(body.messages ?? body.input ?? [])) + count(JSON.stringify(body.tools ?? [])) + count(JSON.stringify(body.instructions ?? body.system ?? '')) + (body.messages?.length ?? 0) * 12 + 512;
    const inputBudget = Math.floor(budget.window * 0.95) - budget.outputTokens;
    for (const limit of [6000, 3000, 1500, 600]) {
      if (promptCost() <= inputBudget) break;
      fadeSummaryTools(body, limit);
    }
    const available = Math.floor(budget.window * 0.95) - promptCost();
    let outputTokens = Math.min(budget.outputTokens, available);
    if (outputTokens < 128) throw new Error('This message and its attachments exceed this model’s conversation capacity. Send a smaller message or increase the capacity in Settings.');
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await request(resource, { ...options, body: JSON.stringify({ ...body, [key]: outputTokens }) });
      if (!response.ok || !response.body) return response;
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let text = '';
      try {
        while (true) {
          options.signal?.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          text += decoder.decode(chunk.value, { stream: true });
          if (text.length > 2000000) throw new Error('Conversation optimization could not finish. Your history is preserved; retry this reply.');
        }
        text += decoder.decode();
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      const frames: Record<string, any>[] = [];
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        for (const event of text.split(/\r?\n\r?\n/)) {
          const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!data || data === '[DONE]') continue;
          try { const frame = JSON.parse(data); if (frame && typeof frame === 'object') frames.push(frame); } catch { /* SDK reports malformed streams. */ }
        }
      } else {
        try { const frame = JSON.parse(text); if (frame && typeof frame === 'object') frames.push(frame); } catch { /* SDK reports malformed bodies. */ }
      }
      if (!frames.some(outputLimit)) {
        // Validate the model's checkpoint text before the SDK adds its own
        // bounded outcome metadata. Internal reasoning is not retained text.
        const visible = frames.map(frame => Array.isArray(frame.choices) ? frame.choices.map((choice: any) => typeof choice?.delta?.content === 'string' ? choice.delta.content : typeof choice?.message?.content === 'string' ? choice.message.content : '').join('')
          : frame.type === 'response.output_text.delta' && typeof frame.delta === 'string' ? frame.delta
          : frame.delta?.type === 'text_delta' && typeof frame.delta.text === 'string' ? frame.delta.text : '').join('');
        if (budget.retainedTokens !== undefined && count(visible) > budget.retainedTokens + 100) throw new Error('Conversation optimization could not finish. Your history is preserved; retry this reply.');
        const headers = new Headers(response.headers);
        headers.delete('content-length'); headers.delete('content-encoding'); headers.delete('transfer-encoding');
        return new Response(text, { status: response.status, statusText: response.statusText, headers });
      }
      // This failed request will not reach the model's normal usage handler.
      const usage = frames.map(frame => frame.response?.usage ?? frame.usage ?? frame.message?.usage).filter(Boolean);
      const safeTokens = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
      if (usage.length) failedUsage?.(Math.max(...usage.map(value => safeTokens(value.prompt_tokens ?? value.input_tokens))), Math.max(...usage.map(value => safeTokens(value.completion_tokens ?? value.output_tokens))));
      options.signal?.throwIfAborted();
      const nextBudget = Math.min(outputTokens * 2, available);
      if (attempt === 1 || nextBudget <= outputTokens) throw new Error(COMPACTION_OUTPUT_LIMIT_MESSAGE);
      outputTokens = nextBudget;
    }
    throw new Error(COMPACTION_OUTPUT_LIMIT_MESSAGE);
  };
}
