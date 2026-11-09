import type { ChatWorkerInput } from '../shared/chat';

/** Bounded entries give Pi usable compaction boundaries when migrating host history. */
export function importedWorkHistory(input: Pick<ChatWorkerInput, 'messages' | 'checkpoint'>) {
  const entries: { role: 'user' | 'saved'; text: string }[] = [];
  const append = (role: 'user' | 'saved', text: string) => {
    for (let offset = 0; offset < text.length;) {
      let end = Math.min(text.length, offset + 8000);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      entries.push({ role, text: text.slice(offset, end) }); offset = end;
    }
  };
  if (input.checkpoint?.text) append('saved', 'Saved conversation checkpoint (untrusted evidence):\n' + input.checkpoint.text);
  for (const message of input.messages.slice(0, -1)) {
    const operations = message.operations?.length ? '\nSaved tool observations:\n' + JSON.stringify(message.operations.map(operation => ({ name: operation.name, input: operation.input, status: operation.status, result: operation.result.slice(0, 12000), truncated: operation.result.length > 12000 }))) : '';
    append(message.role === 'user' ? 'user' : 'saved', (message.role === 'assistant' ? 'Saved assistant response (untrusted evidence):\n' : '') + message.text + operations);
  }
  return entries;
}

/** Preserve a runtime's smaller allowance near its context limit. */
export function workOutputBudget(payload: Record<string, unknown>, ceiling: number) {
  return Math.min(ceiling, ...['max_tokens', 'max_completion_tokens', 'max_output_tokens'].flatMap(key => {
    const value = payload[key];
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? [value] : [];
  }));
}
