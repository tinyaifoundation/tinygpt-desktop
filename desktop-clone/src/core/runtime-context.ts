// Keep this small and independent of harness prompts, memory and tool access.
const start = '<tinygpt-runtime-context>';
const end = '</tinygpt-runtime-context>';

export function runtimeContext(now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)!.value;
  const offset = value('timeZoneName').replace('GMT', '') || '+00:00';
  const timestamp = `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}:${value('second')}${offset}`;
  return `${start}\nYou are the assistant inside TinyGPT Desktop. TinyGPT refers to this application, including Chat, Work and Bot, rather than the underlying model/provider. Keep your assigned role and personality.\nReply start local date/time: ${timestamp} (${value('weekday')}; ${timeZone}). Use this date and timezone for relative dates in the user request, such as today, tomorrow and this week. This is a snapshot at reply start, not a live clock.\n${end}`;
}

function append(content: unknown, note: string): unknown {
  if (Array.isArray(content)) return [...content.filter(block => !(block?.type === 'text' && typeof block.text === 'string' && block.text.startsWith(start) && block.text.endsWith(end))), { type: 'text', text: note }];
  let text = typeof content === 'string' ? content : '';
  const previous = text.lastIndexOf('\n\n' + start);
  if (previous >= 0 && text.endsWith(end)) text = text.slice(0, previous);
  else if (text.startsWith(start) && text.endsWith(end)) text = '';
  return text ? `${text}\n\n${note}` : note;
}

export function withRuntimeContext(body: Record<string, any>, format: 'chat/completions' | 'responses' | 'messages', now = new Date(), timeZone?: string): Record<string, any> {
  const note = runtimeContext(now, timeZone);
  if (format === 'responses') return { ...body, instructions: append(body.instructions, note) };
  if (format === 'messages') return { ...body, system: append(body.system, note) };
  const messages = [...body.messages];
  const index = messages.findIndex(message => message.role === 'system' || message.role === 'developer');
  if (index < 0) messages.unshift({ role: 'system', content: note });
  else messages[index] = { ...messages[index], content: append(messages[index].content, note) };
  return { ...body, messages };
}

/** One transport belongs to one reply/worker request chain. Keep its clock
 * snapshot stable through tool calls and retries: changing a leading system
 * timestamp invalidates the entire conversation prefix on recurrent models.
 * A new reply or resumed run creates a new transport and a fresh snapshot. */
export function runtimeContextFetch(request: typeof fetch, now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): typeof fetch {
  const startedAt = new Date(now.getTime());
  return async (resource, options) => {
    const original = resource instanceof Request ? resource : undefined;
    const url = new URL(original?.url ?? String(resource));
    const format = url.pathname.match(/\/(chat\/completions|responses|messages)\/?$/)?.[1] as 'chat/completions' | 'responses' | 'messages' | undefined;
    if (!format || (options?.method ?? original?.method ?? 'GET').toUpperCase() !== 'POST') return request(resource, options);
    const raw = options?.body !== undefined ? options.body : original ? await original.clone().text() : undefined;
    if (typeof raw !== 'string') return request(resource, options);
    let body: Record<string, any>;
    try { body = JSON.parse(raw); } catch { return request(resource, options); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || (format === 'responses' ? typeof body.input !== 'string' && !Array.isArray(body.input) : !Array.isArray(body.messages))) return request(resource, options);
    const headers = new Headers(options?.headers ?? original?.headers);
    headers.delete('content-length');
    return request(resource, { ...options, headers, body: JSON.stringify(withRuntimeContext(body, format, startedAt, timeZone)) });
  };
}
