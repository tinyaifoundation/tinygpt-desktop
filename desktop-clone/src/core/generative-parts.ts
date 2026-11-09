import type { ThreadMessageLike } from '@assistant-ui/react';
import type { ToolActivity } from '../shared/tools';
import type { ChatMessage } from '../shared/chat';

export function generativeParts(tools: ToolActivity[]): Exclude<ThreadMessageLike['content'], string> {
  return tools.filter(tool => tool.name === 'present').map(tool => {
    let args = {}; let result: unknown;
    if (tool.remotePresentation) {
      args = { remotePresentation: { conversationId: tool.conversationId, toolId: tool.id, ...tool.remotePresentation } };
      if (tool.status === 'success') result = { presented: true };
      if (!['pending', 'running', 'success'].includes(tool.status)) result = { error: 'The interface did not finish.' };
    } else if (tool.status === 'success' || tool.status === 'running' && tool.result) {
      try { args = JSON.parse(tool.result ?? '{}').ui ?? {}; if (tool.status === 'success') result = { presented: true }; }
      catch { result = { error: 'The saved interface could not be read.' }; }
    } else if (!['pending', 'running'].includes(tool.status)) result = { error: tool.result ?? 'The interface did not finish.' };
    return { type: 'tool-call', toolCallId: tool.id, toolName: 'present', args, argsText: JSON.stringify(args), ...(result !== undefined ? { result } : {}), isError: !!result && typeof result === 'object' && 'error' in result };
  });
}

// New replies record the text boundary of every presentation. Older replies
// retain their original per-run placement, including continued answers.
export function generativeAnswerParts(message: Pick<ChatMessage, 'text' | 'runId' | 'continuationOf' | 'presentations'>, tools: ToolActivity[], messages: ReadonlyMap<string, ChatMessage> = new Map()): Exclude<ThreadMessageLike['content'], string> {
  const offsets = new Map<string | null, number>();
  const positions = new Map(message.presentations?.map(item => [item.toolId, item.offset]));
  const seen = new Set<string>();
  let current = message;
  while (true) {
    const prior = current.continuationOf && !seen.has(current.continuationOf) ? messages.get(current.continuationOf) : undefined;
    const offset = prior && message.text.startsWith(prior.text) ? prior.text.length : 0;
    offsets.set(current.runId, offset);
    for (const item of current.presentations ?? []) if (!positions.has(item.toolId)) positions.set(item.toolId, item.offset);
    if (!prior) break;
    seen.add(current.continuationOf!); current = prior;
  }
  const presentations = tools.filter(tool => tool.name === 'present').map(tool => ({ tool, offset: Math.max(0, Math.min(message.text.length, positions.get(tool.id) ?? offsets.get(tool.runId) ?? 0)) })).sort((a, b) => a.offset - b.offset);
  if (!presentations.length) return [{ type: 'text', text: message.text }];
  const parts: Array<Exclude<ThreadMessageLike['content'], string>[number]> = [];
  let start = 0;
  for (const { tool, offset } of presentations) {
    if (offset > start) parts.push({ type: 'text', text: message.text.slice(start, offset) });
    parts.push(...generativeParts([tool])); start = offset;
  }
  if (start < message.text.length) parts.push({ type: 'text', text: message.text.slice(start) });
  return parts;
}
