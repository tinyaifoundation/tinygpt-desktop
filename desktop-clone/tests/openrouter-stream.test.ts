import { describe, expect, it, vi } from 'vitest';
import { openRouterStreamFetch } from '../src/core/openrouter-stream';
describe('OpenRouter stream compatibility', () => {
  it('forwards reasoning and reports tool preparation before the arguments finish across split SSE chunks', async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>; const enc = new TextEncoder(); const preparing = vi.fn();
    const original = new Response(new ReadableStream<Uint8Array>({ start(controller) { source = controller; } }), { headers: { 'content-type': 'text/event-stream' } });
    const normalized = await openRouterStreamFetch(vi.fn(async () => original) as typeof fetch, preparing)('https://example.org/'); const reader = normalized.body!.getReader();
    const thinking = JSON.stringify({ choices: [{ delta: { reasoning: 'Thinking ü' } }] });
    source.enqueue(enc.encode(`: keepalive\r\n\r\ndata: ${thinking.slice(0, 30)}`)); expect(new TextDecoder().decode((await reader.read()).value)).toContain('keepalive');
    source.enqueue(enc.encode(`${thinking.slice(30)}\r\n\r\n`)); expect(new TextDecoder().decode((await reader.read()).value)).toContain('"reasoning_content":"Thinking ü"');
    source.enqueue(enc.encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"write_project_file","arguments":"{"}}]}}]}\n\n'));
    await reader.read(); expect(preparing).toHaveBeenCalledOnce();
    source.enqueue(enc.encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]}}]}\n\ndata: [DONE]\n\n')); source.close();
    let rest = ''; for (;;) { const chunk = await reader.read(); if (chunk.done) break; rest += new TextDecoder().decode(chunk.value); } expect(rest).toContain('[DONE]'); expect(preparing).toHaveBeenCalledOnce();
  });
  it('uses text reasoning details but preserves existing reasoning_content and error responses', async () => {
    const frame = { choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', text: 'Visible thinking' }, { type: 'reasoning.encrypted', data: 'private' }] } }, { delta: { reasoning: 'duplicate', reasoning_content: 'original' } }] };
    const response = new Response(`data: ${JSON.stringify(frame)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    const text = await (await openRouterStreamFetch(vi.fn(async () => response) as typeof fetch, () => {})('https://example.org/')).text(); expect(text).toContain('"reasoning_content":"Visible thinking"'); expect(text).toContain('"reasoning_content":"original"');
    const failed = new Response('error', { status: 503 }); expect(await openRouterStreamFetch(vi.fn(async () => failed) as typeof fetch, () => {})('https://example.org/')).toBe(failed);
  });
  it('preserves cancellation on the original stream', async () => {
    const cancel = vi.fn(); const original = new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'text/event-stream' } });
    const response = await openRouterStreamFetch(vi.fn(async () => original) as typeof fetch, () => {})('https://example.org/'); await response.body!.cancel('Stopped'); expect(cancel).toHaveBeenCalledWith('Stopped');
  });
});
