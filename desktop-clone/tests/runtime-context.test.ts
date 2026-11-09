import { afterEach, expect, it, vi } from 'vitest';
import { runtimeContext, runtimeContextFetch, withRuntimeContext } from '../src/core/runtime-context';
import { scopedFetch } from '../src/core/librechat';
import { contextPolicy } from '../src/core/context';

afterEach(() => vi.useRealTimers());

it('identifies the host app without replacing the assigned Bot identity', () => {
  const original = { model: 'provider-model', messages: [{ role: 'system', content: 'You are Milo. Keep replies brief.' }, { role: 'user', content: 'What can TinyGPT do?' }], tools: [{ name: 'fixture' }], temperature: 0.3 };
  const before = structuredClone(original);
  const result = withRuntimeContext(original, 'chat/completions', new Date('2026-11-05T15:23:45Z'), 'America/New_York');
  expect(result.messages[0].content).toContain('You are Milo. Keep replies brief.');
  expect(result.messages[0].content).toContain('assistant inside TinyGPT Desktop');
  expect(result.messages[0].content).toContain('rather than the underlying model/provider');
  expect(result.messages[0].content).toContain('2026-11-05T10:23:45-05:00 (Thursday; America/New_York)');
  expect(result.messages[1]).toEqual(before.messages[1]);
  expect(result.tools).toBe(original.tools); expect(result.model).toBe(original.model); expect(result.temperature).toBe(original.temperature);
  expect(original).toEqual(before);
});

it.each([
  ['2026-11-06T04:59:59Z', '2026-11-05T23:59:59-05:00'],
  ['2026-11-06T05:00:01Z', '2026-11-06T00:00:01-05:00'],
  ['2026-03-08T06:59:59Z', '2026-03-08T01:59:59-05:00'],
  ['2026-03-08T07:00:01Z', '2026-03-08T03:00:01-04:00'],
])('uses the actual local day and daylight saving offset at %s', (iso, local) => {
  expect(runtimeContext(new Date(iso), 'America/New_York')).toContain(local);
});

it('supports UTC and non-hour timezone offsets', () => {
  const now = new Date('2026-11-05T00:00:00Z');
  expect(runtimeContext(now, 'UTC')).toContain('2026-11-05T00:00:00+00:00');
  expect(runtimeContext(now, 'Asia/Kathmandu')).toContain('2026-11-05T05:45:00+05:45');
});

it('preserves Responses instructions and Anthropic cached system blocks', () => {
  const responses = { instructions: 'Return only JSON.', input: 'Today?', text: { format: { type: 'json_object' } } };
  expect(withRuntimeContext(responses, 'responses').instructions).toContain('Return only JSON.');
  expect(withRuntimeContext(responses, 'responses').input).toBe(responses.input);
  const block = { type: 'text', text: 'Existing instructions.', cache_control: { type: 'ephemeral' } };
  const anthropic = { system: [block], messages: [{ role: 'user', content: 'Today?' }] };
  const result = withRuntimeContext(anthropic, 'messages');
  expect(result.system).toHaveLength(2); expect(result.system[0]).toBe(block);
  expect(result.system[1].text).toContain('Reply start local date/time');
  expect(anthropic.system).toEqual([block]);
});

it('adds a system message only when none exists and preserves developer roles', () => {
  const user = { role: 'user', content: 'Today?' };
  expect(withRuntimeContext({ messages: [user] }, 'chat/completions').messages).toEqual([expect.objectContaining({ role: 'system' }), user]);
  const result = withRuntimeContext({ messages: [{ role: 'developer', content: 'Keep this role.' }, user] }, 'chat/completions');
  expect(result.messages).toHaveLength(2); expect(result.messages[0].role).toBe('developer');
});

it.each(['chat/completions', 'responses', 'messages'] as const)('refreshes %s context without accumulating old timestamps', format => {
  const body = format === 'responses' ? { input: 'Today?', instructions: 'Original.' } : format === 'messages' ? { messages: [{ role: 'user', content: 'Today?' }], system: [{ type: 'text', text: 'Original.' }] } : { messages: [{ role: 'system', content: 'Original.' }, { role: 'user', content: 'Today?' }] };
  const first = withRuntimeContext(body, format, new Date('2026-11-05T23:59:59Z'), 'UTC');
  const second = withRuntimeContext(first, format, new Date('2026-11-06T00:00:01Z'), 'UTC');
  const text = JSON.stringify(second);
  expect(text).not.toContain('2026-11-05'); expect(text).toContain('2026-11-06T00:00:01');
  expect(text.match(/<tinygpt-runtime-context>/g)).toHaveLength(1); expect(text).toContain('Original.');
});

it('keeps the leading clock stable through tool follow-ups and refreshes a new reply, preserving transport options', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-05T23:59:59Z'));
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
  const send = scopedFetch('https://fixture.invalid/v1', request), controller = new AbortController();
  const options = { method: 'POST', headers: { Authorization: 'Bearer fixture', 'Content-Length': '1' }, signal: controller.signal, body: JSON.stringify({ messages: [{ role: 'user', content: 'Today?' }] }) };
  await send('https://fixture.invalid/v1/chat/completions', options);
  vi.setSystemTime(new Date('2026-11-06T00:00:01Z'));
  await send('https://fixture.invalid/v1/chat/completions', options);
  const first = request.mock.calls[0][1]!, second = request.mock.calls[1][1]!;
  expect(first.body).toBe(second.body); expect(second.signal).toBe(controller.signal); expect(second.redirect).toBe('error');
  await scopedFetch('https://fixture.invalid/v1', request)('https://fixture.invalid/v1/chat/completions', options);
  expect(request.mock.calls[2][1]?.body).not.toBe(first.body);
  expect(JSON.parse(String(request.mock.calls[2][1]?.body)).messages[0].content).toBe(runtimeContext(new Date('2026-11-06T00:00:01Z')));
  expect(new Headers(second.headers).get('Authorization')).toBe('Bearer fixture');
  expect(new Headers(second.headers).has('content-length')).toBe(false); expect(options.headers['Content-Length']).toBe('1');
  expect(options.body).not.toContain('runtime-context');
});

it.each(['chat/completions', 'responses', 'messages'] as const)('preserves the %s instruction prefix across a long tool loop, even across midnight', async format => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-05T23:59:59Z'));
  const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}'));
  const send = runtimeContextFetch(request, new Date(), 'UTC');
  const initial = format === 'responses' ? { instructions: 'Keep these instructions.', input: [{ role: 'user', content: 'Do the task.' }] } : format === 'messages' ? { system: 'Keep these instructions.', messages: [{ role: 'user', content: 'Do the task.' }] } : { messages: [{ role: 'system', content: 'Keep these instructions.' }, { role: 'user', content: 'Do the task.' }] };
  await send(`https://fixture.invalid/v1/${format}`, { method: 'POST', body: JSON.stringify(initial) });
  vi.setSystemTime(new Date('2026-11-06T01:00:01Z'));
  const followup = structuredClone(initial) as any;
  const history = format === 'responses' ? followup.input : followup.messages;
  history.push({ role: 'assistant', content: 'A completed action.' });
  await send(`https://fixture.invalid/v1/${format}`, { method: 'POST', body: JSON.stringify(followup) });
  const [first, second] = request.mock.calls.map(call => JSON.parse(String(call[1]?.body)));
  const instructions = (body: any) => format === 'responses' ? body.instructions : format === 'messages' ? body.system : body.messages[0];
  expect(instructions(second)).toEqual(instructions(first));
  expect(JSON.stringify(second)).toContain('2026-11-05T23:59:59');
  expect(JSON.stringify(second).match(/<tinygpt-runtime-context>/g)).toHaveLength(1);
  expect(history.at(-1).content).toBe('A completed action.');
});

it('handles Request bodies without consuming or losing original credentials', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
  const original = new Request('https://fixture.invalid/v1/responses', { method: 'POST', headers: { Authorization: 'Bearer fixture' }, body: JSON.stringify({ instructions: 'Original.', input: 'Today?' }) });
  await runtimeContextFetch(request)(original);
  expect(original.bodyUsed).toBe(false);
  expect(request.mock.calls[0][1]?.body).toContain('Original.');
  expect(request.mock.calls[0][1]?.body).toContain('runtime-context');
  expect(new Headers(request.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer fixture');
});

it('leaves catalogs, non-JSON and non-inference payloads untouched and retains endpoint restrictions', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
  const send = scopedFetch('https://fixture.invalid/v1', request);
  for (const [path, options] of [
    ['models', { method: 'GET' }], ['embeddings', { method: 'POST', body: '{"input":"hello"}' }],
    ['chat/completions', { method: 'POST', body: 'invalid' }], ['chat/completions', { method: 'POST', body: '{}' }],
  ] as const) { await send(`https://fixture.invalid/v1/${path}`, options); expect(request.mock.calls.at(-1)?.[1]?.body).toBe('body' in options ? options.body : undefined); }
  await expect(send('https://elsewhere.invalid/v1/chat/completions', { method: 'POST', body: '{}' })).rejects.toThrow('outside the configured endpoint');
});

it('keeps the additive note within existing context headroom without changing replay budgets', () => {
  const policy = contextPolicy({ route: 'local', contextWindowTokens: 4096 });
  const estimatedTokens = Math.ceil(runtimeContext(new Date(), 'America/Argentina/Buenos_Aires').length / 3);
  expect(estimatedTokens).toBeLessThan(192);
  expect(policy.inputTokens + policy.outputTokens + estimatedTokens).toBeLessThan(policy.window);
  expect(contextPolicy({ route: 'byok', contextWindowTokens: 1000000 }).inputTokens).toBe(64000);
});
