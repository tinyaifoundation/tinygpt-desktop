import { expect, it, vi } from 'vitest';
import { promptProgressObserver, workRequestAudit, workRequestPayload } from '../src/core/work-request';
import { providerActivityFetch } from '../src/core/provider-activity';
import { traceEventSchema } from '../src/shared/diagnostics';
import { scopedFetch } from '../src/core/librechat';

it('requests native caching/progress only from declared local llama.cpp providers', () => {
  const local = { provider: 'local', protocol: 'openai-compatible', reasoning: { kind: 'llamacpp', efforts: [], canDisable: true } } as const;
  expect(workRequestPayload({ max_tokens: 2048 }, local as any)).toEqual({ max_tokens: 2048, cache_prompt: true, return_progress: true });
  for (const changed of [{ provider: 'openrouter' }, { provider: 'custom' }, { reasoning: undefined }]) expect(workRequestPayload({}, { ...local, ...changed } as any)).toEqual({});
});
it('distinguishes actual native reused/processed token counters without leaking streamed text', async () => {
  const traces: any[] = [], raw = 'data: {"prompt_progress":{"total":12000,"cache":11000,"processed":12000,"time_ms":250}}\n\ndata: {"choices":[{"delta":{"reasoning_content":"PRIVATE_THOUGHT"}}]}\n\n';
  const request = providerActivityFetch(async () => new Response(raw), () => {}, event => traces.push(event));
  const response = await request('http://fixture', { body: JSON.stringify({ return_progress: true, messages: [{ role: 'user', content: 'PRIVATE_PROMPT' }] }) });
  expect(await response.text()).toBe(raw);
  expect(traces).toContainEqual(expect.objectContaining({ event: 'prompt-progress', inputTokens: 12000, cacheReadTokens: 11000, promptProcessedTokens: 1000, promptProcessingMs: 250 }));
  for (const event of traces) expect(traceEventSchema.safeParse(event).success).toBe(true);
  expect(JSON.stringify(traces)).not.toMatch(/PRIVATE_THOUGHT|PRIVATE_PROMPT/);
});
it('handles fragmented progress and ignores malformed or oversized counters', () => {
  const trace = vi.fn(), observe = promptProgressObserver(trace), encode = (s: string) => new TextEncoder().encode(s);
  observe(encode('data: {"prompt_pro')); observe(encode('gress":{"total":10,"cache":8,"processed":10,"time_ms":20}}\n'));
  observe(encode('data: {"prompt_progress":{"total":10,"cache":11,"processed":10,"time_ms":20}}\n'));
  expect(trace).toHaveBeenCalledOnce();
});
it('counts payload composition and stable prefix messages without retaining or returning their contents', () => {
  const audit = workRequestAudit(), first = { messages: [{ role: 'system', content: 'System' }, { role: 'user', content: 'SECRET' }], tools: [] };
  expect(audit(first)).toMatchObject({ event: 'request-shape', messageCount: 2, stablePrefixMessages: 0, promptCharacters: { system: 6, user: 6 } });
  const next = audit({ ...first, messages: [...first.messages, { role: 'tool', content: 'result' }] });
  expect(next).toMatchObject({ stablePrefixMessages: 2, schemasChanged: false, promptCharacters: { toolResults: 6 } });
  expect(audit({ ...first, messages: [{ role: 'system', content: 'Changed' }] })).toMatchObject({ stablePrefixMessages: 0 });
  expect(JSON.stringify(next)).not.toContain('SECRET');
});

it('measures the final provider body including the clock note and retains its prefix across tools', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-05T15:00:00Z'));
  try {
    const bodies: any[] = [], traces: any[] = [];
    const request: typeof fetch = async (_resource, options) => { bodies.push(JSON.parse(String(options?.body))); return new Response('data: [DONE]\n\n'); };
    const send = scopedFetch('https://fixture.invalid/v1', providerActivityFetch(request, () => {}, e => traces.push(e)));
    const messages = [{ role: 'system', content: 'Instructions.' }, { role: 'user', content: 'Do the task.' }];
    await (await send('https://fixture.invalid/v1/chat/completions', { method: 'POST', body: JSON.stringify({ return_progress: true, messages }) })).text();
    vi.setSystemTime(new Date('2026-11-05T15:02:00Z'));
    await (await send('https://fixture.invalid/v1/chat/completions', { method: 'POST', body: JSON.stringify({ return_progress: true, messages: [...messages, { role: 'assistant', content: 'Finished a step.' }] }) })).text();
    const shapes = traces.filter(e => e.event === 'request-shape');
    expect(bodies[0].messages[0].content).toContain('Reply start local date/time');
    expect(shapes[0].promptCharacters.system).toBe(bodies[0].messages[0].content.length);
    expect(shapes[1].stablePrefixMessages).toBe(2);
    expect(JSON.stringify(traces)).not.toContain('Instructions.');
  } finally { vi.useRealTimers(); }
});
