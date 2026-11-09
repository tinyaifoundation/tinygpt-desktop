import { describe, expect, it } from 'vitest';
import { compactionFetch } from '../src/core/compaction';
import { COMPACTION_OUTPUT_LIMIT_MESSAGE } from '../src/shared/chat';

const count = (text: string) => Math.ceil(text.length / 4);
const budget = { window: 32768, outputTokens: 8192 };
const endpoint = 'https://fixture.example/v1/chat/completions';
const options = { body: JSON.stringify({ messages: [{ role: 'user', content: 'Checkpoint this conversation.' }], max_tokens: 1500 }), method: 'POST' };
const sse = (frames: unknown[]) => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n', { headers: { 'content-type': 'text/event-stream' } });

describe('checkpoint generation recovery', () => {
  it.each(['max_tokens', 'max_completion_tokens', 'max_output_tokens'])('separates checkpoint size from %s and retries once', async key => {
    const requests: any[] = []; const usage: number[][] = [];
    const wrapped = compactionFetch(async (_resource, options) => {
      requests.push(JSON.parse(options!.body as string));
      return requests.length === 1 ? sse([{ choices: [{ finish_reason: 'length' }], usage: { prompt_tokens: 30, completion_tokens: 8192 } }]) : sse([{ choices: [{ delta: { content: 'Valid checkpoint.' }, finish_reason: 'stop' }] }]);
    }, () => true, budget, count, (input, output) => usage.push([input, output]));
    const result = await wrapped(endpoint, { ...options, body: JSON.stringify({ messages: [{ role: 'user', content: 'Checkpoint.' }], [key]: 1500 }) });
    expect(requests.map(body => body[key])).toEqual([8192, 16384]);
    expect(await result.text()).toContain('Valid checkpoint.'); expect(usage).toEqual([[30, 8192]]);
  });
  it.each([
    [{ choices: [{ finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 1500 } }],
    [{ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 10, output_tokens: 1500 } } }],
    [{ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } }, { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 1500 } }],
  ])('rejects persistent truncation across provider formats (%j)', async (...frames) => {
    let requests = 0; const usage: number[][] = [];
    const wrapped = compactionFetch(async () => { requests++; return sse(frames); }, () => true, budget, count, (input, output) => usage.push([input, output]));
    await expect(wrapped(endpoint, options)).rejects.toThrow(COMPACTION_OUTPUT_LIMIT_MESSAGE);
    expect(requests).toBe(2); expect(usage).toEqual([[10, 1500], [10, 1500]]);
  });
  it('leaves ordinary requests streaming without retries or budget changes', async () => {
    const original = sse([{ choices: [{ finish_reason: 'length' }] }]); let calls = 0;
    const wrapped = compactionFetch(async (_resource, received) => { calls++; expect(received).toBe(options); return original; }, () => false, budget, count);
    expect(await wrapped(endpoint, options)).toBe(original); expect(calls).toBe(1); expect(original.bodyUsed).toBe(false);
  });
  it('fades only tool evidence before reserving generation space', async () => {
    const original = { messages: [{ role: 'user', content: 'Preserve BLUEBIRD exactly.' }, { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search_sources', arguments: '{"query":"BLUEBIRD"}' } }] }, { role: 'tool', tool_call_id: 'call_1', content: `HEAD${'Evidence '.repeat(20000)}TAIL` }], max_tokens: 1500 };
    let received: any;
    await compactionFetch(async (_resource, options) => { received = JSON.parse(options!.body as string); return sse([{ choices: [{ finish_reason: 'stop' }] }]); }, () => true, budget, count)(endpoint, { ...options, body: JSON.stringify(original) });
    expect(received.messages[0]).toEqual(original.messages[0]); expect(received.messages[1]).toEqual(original.messages[1]);
    expect(received.messages[2].tool_call_id).toBe('call_1'); expect(received.messages[2].content).toContain('HEAD'); expect(received.messages[2].content).toContain('TAIL'); expect(received.messages[2].content).toContain('Earlier result excerpt');
    expect(original.messages[2].content!.length).toBeGreaterThan(100000); expect(received.max_tokens).toBe(8192);
  });
  it('does not exceed remaining context space or retry with the same budget', async () => {
    let calls = 0;
    const small = { window: 8192, outputTokens: 4096 };
    const wrapped = compactionFetch(async (_resource, options) => { calls++; const body = JSON.parse(options!.body as string); expect(body.max_tokens).toBeLessThan(4096); return sse([{ choices: [{ finish_reason: 'length' }] }]); }, () => true, small, count);
    await expect(wrapped(endpoint, { ...options, body: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(20000) }], max_tokens: 1500 }) })).rejects.toThrow(COMPACTION_OUTPUT_LIMIT_MESSAGE);
    expect(calls).toBe(1);
  });
  it('does not retry an HTTP error or retry after cancellation', async () => {
    let calls = 0;
    const failed = new Response('{}', { status: 500 });
    const wrapped = compactionFetch(async () => { calls++; return failed; }, () => true, budget, count);
    expect(await wrapped(endpoint, options)).toBe(failed); expect(calls).toBe(1);
    const controller = new AbortController(); calls = 0;
    const cancelled = compactionFetch(async () => { calls++; controller.abort(); return sse([{ choices: [{ finish_reason: 'length' }] }]); }, () => true, budget, count);
    await expect(cancelled(endpoint, { ...options, signal: controller.signal })).rejects.toThrow(); expect(calls).toBe(1);
  });
  it('rejects oversized checkpoint text independently of the reasoning budget', async () => {
    const wrapped = compactionFetch(async () => sse([{ choices: [{ delta: { reasoning_content: 'Reasoning '.repeat(3000), content: 'Checkpoint '.repeat(3000) }, finish_reason: 'stop' }] }]), () => true, { ...budget, retainedTokens: 1500 }, count);
    await expect(wrapped(endpoint, options)).rejects.toThrow('Conversation optimization could not finish');
  });
});
