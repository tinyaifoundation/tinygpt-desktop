import { describe, expect, it, vi } from 'vitest';
import { providerActivityFetch } from '../src/core/provider-activity';
import { compactionFetch } from '../src/core/compaction';
import { chatError } from '../src/core/chat-errors';
import { REPLY_TIMEOUT_MESSAGE } from '../src/shared/chat-timeouts';

describe('provider transport activity', () => {
  it('records an aborted pending connection or stream read as cancellation', async () => {
    for (const connected of [false, true]) {
      const abort = new AbortController(), events: { event: string }[] = [];
      const failure = new DOMException('Aborted', 'AbortError');
      const original = new Response(new ReadableStream({ start(controller) { abort.signal.addEventListener('abort', () => controller.error(failure)); } }));
      const request = providerActivityFetch((async () => {
        if (connected) return original;
        abort.abort(); throw failure;
      }) as typeof fetch, () => {}, event => events.push(event));
      const pending = request('https://example.org/', { signal: abort.signal }).then(response => response.text());
      if (connected) abort.abort();
      await expect(pending).rejects.toBe(failure);
      expect(events.at(-1)?.event).toBe('request-cancelled');
    }
  });
  it('distinguishes normal SDK stream closure from user cancellation',async()=>{
    for(const aborted of [false,true]){
      const events: {event:string}[]=[];const controller=new AbortController();
      const response=await providerActivityFetch((async()=>new Response(new ReadableStream())) as typeof fetch,()=>{},event=>events.push(event))('https://example.org',{signal:controller.signal});
      if(aborted)controller.abort();await response.body!.cancel();
      expect(events.at(-1)?.event).toBe(aborted?'request-cancelled':'request-closed');
      expect(events.some(event=>event.event==='request-error')).toBe(false);
    }
  });
  it('reports checkpoint bytes before the buffered response is released and preserves the stream', async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), { headers: { 'Content-Type': 'text/event-stream' } });
    const activity = vi.fn(); const request = providerActivityFetch(vi.fn(async () => response) as typeof fetch, activity);
    const compact = compactionFetch(request, () => true, { outputTokens: 256, window: 8192 }, text => Math.ceil(text.length / 4));
    let released = false; const pending = compact('https://example.org/v1/chat/completions', { body: JSON.stringify({ max_tokens: 256, messages: [{ role: 'user', content: 'Summarize' }] }) }).then(result => { released = true; return result; });
    stream.enqueue(new TextEncoder().encode(': provider keepalive\n\n')); await vi.waitFor(() => expect(activity).toHaveBeenCalledWith('data')); expect(released).toBe(false);
    stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Checkpoint"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')); stream.close();
    expect(await (await pending).text()).toContain('Checkpoint'); expect(activity.mock.calls.map(call => call[0])).toEqual(['request', 'response', 'data', 'data']);
  });
  it('cancels the original body when the tracked response is cancelled', async () => {
    const cancel = vi.fn(); const original = new Response(new ReadableStream({ cancel }));
    const response = await providerActivityFetch(vi.fn(async () => original) as typeof fetch, () => {})('https://example.org/');
    await response.body!.cancel('Stopped'); expect(cancel).toHaveBeenCalledWith('Stopped');
  });
  it('records request phases without bodies, credentials, URLs, or response text', async () => {
    const events: unknown[] = []; const request = providerActivityFetch(vi.fn(async () => new Response('private-response', { status: 200 })) as typeof fetch, () => {}, event => events.push(event), () => 'summary');
    expect(await (await request('https://private.example/token', { body: 'private-prompt', headers: { Authorization: 'private-credential' } })).text()).toBe('private-response');
    expect(events).toMatchObject([{ event: 'request-start', purpose: 'summary' }, { event: 'request-headers', status: 200 }, { event: 'request-first-data', bytes: 16, chunks: 1 }, { event: 'request-end', bytes: 16, chunks: 1 }]);
    expect(JSON.stringify(events)).not.toContain('private');
  });
  it('records stream and connection failures without altering them or allowing an observer to break fetch', async () => {
    const events: { event: string }[] = []; const failure = new Error('private-provider-error');
    const request = providerActivityFetch(vi.fn(async () => { throw failure; }) as typeof fetch, () => {}, event => events.push(event));
    await expect(request('https://example.org/')).rejects.toBe(failure); expect(events.map(value => value.event)).toEqual(['request-start', 'request-error']);
    const original = new Response(new ReadableStream({ pull(controller) { controller.error(failure); } }));
    const stream = await providerActivityFetch(vi.fn(async () => original) as typeof fetch, () => {}, event => events.push(event))('https://example.org/');
    await expect(stream.text()).rejects.toBe(failure); expect(events.at(-1)?.event).toBe('request-error');
    const safe = providerActivityFetch(vi.fn(async () => new Response('ok')) as typeof fetch, () => {}, () => { throw failure; }); expect(await (await safe('https://example.org/')).text()).toBe('ok');
  });
  it('sanitizes upstream timeout errors without exposing request details', () => {
    const error = new Error('credential-secret and request details'); error.name = 'APIConnectionTimeoutError'; expect(chatError(error)).toBe(REPLY_TIMEOUT_MESSAGE);
  });
});
