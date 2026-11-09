type Message = { role?: string; content?: unknown; [key: string]: unknown };

/** A pruned tool loop may contain only assistant/tool turns. Bonsai requires
 * a real user turn even then. Keep a bounded task anchor in the user role,
 * before the recorded actions; never promote source/tool text into instructions. */
export function localQueryAnchor(messages: Message[], goal: string): Message[] {
  if (messages.some(message => message.role === 'user' && !(typeof message.content === 'string' && message.content.trim().startsWith('<tool_response>') && message.content.trim().endsWith('</tool_response>')))) return messages;
  const anchor = { role: 'user', content: `Continue the existing task from the saved context and recorded operation outcomes. Recheck uncertain effects before retrying an action.\nTask excerpt: ${goal.slice(0, 1600)}` };
  const header = messages[0]?.role === 'system' ? 1 : 0;
  return [...messages.slice(0, header), anchor, ...messages.slice(header)];
}

/** Runs at the final local transport boundary, after SDK pruning/compaction. */
export function localModelFetch(request: typeof fetch, goal: string): typeof fetch {
  return (resource, options) => {
    if (typeof options?.body === 'string') {
      const body = JSON.parse(options.body);
      if (Array.isArray(body.messages)) {
        body.messages = localQueryAnchor(body.messages, goal);
        // Explicitly retain the shared prefix across local chat/tool turns.
        body.cache_prompt = true;
        options = { ...options, body: JSON.stringify(body) };
      }
    }
    return request(resource, options);
  };
}

/** Strict local chat templates allow one system message, at the beginning. */
export function localWorkGuidance(messages: Message[], guidance: string): Message[] {
  const system = messages.filter(message => message.role === 'system');
  const contents = system.map(message => message.content);
  const content = contents.some(Array.isArray)
    ? [...contents.flatMap(value => Array.isArray(value) ? value : typeof value === 'string' ? [{ type: 'text', text: value }] : []), { type: 'text', text: guidance }]
    : [...contents.filter((value): value is string => typeof value === 'string'), guidance].join('\n\n');
  // Preserve the relative order and exact payloads of user/assistant/tool turns.
  // Only messages already carrying the trusted system role move into the header.
  return [{ ...system[0], role: 'system', content }, ...messages.filter(message => message.role !== 'system')];
}
