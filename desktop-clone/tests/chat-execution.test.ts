import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatWorkerInput } from '../src/shared/chat';
import { FIRST_RESPONSE_TIMEOUT_MS, REPLY_IDLE_TIMEOUT_MS, REPLY_TIMEOUT_MESSAGE } from '../src/shared/chat-timeouts';
const fake = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock('electron', () => ({ utilityProcess: { fork: fake.fork } }));
import { chatExecution, closeChatRuntime, warmChatRuntime, measureChatContext } from '../src/main/chat-execution';

class Worker extends EventEmitter { postMessage = vi.fn(); kill = vi.fn(); }
let worker: Worker;
const input: ChatWorkerInput = { runId: randomUUID(), route: 'byok', provider: 'openrouter', protocol: 'openai-compatible', endpoint: 'https://openrouter.ai/api/v1', model: 'fixture', secret: 'fixture', instructions: '', messages: [{ role: 'user', text: 'Continue the task' }] };
beforeEach(() => { vi.useFakeTimers(); worker = new Worker(); fake.fork.mockReset().mockReturnValue(worker); });
afterEach(() => { closeChatRuntime(); vi.clearAllTimers(); vi.useRealTimers(); vi.clearAllMocks(); });

describe('reply inactivity watchdog', () => {
  it('leases separate workers concurrently, stops only the target, and reuses an idle worker', async () => {
    const a = new Worker(), b = new Worker(); fake.fork.mockReturnValueOnce(a).mockReturnValueOnce(b);
    const controller = new AbortController(); const deltaA = vi.fn(), deltaB = vi.fn();
    const first = chatExecution.run(input, controller.signal, deltaA); const cancelled = expect(first).rejects.toThrow('Cancelled');
    const second = chatExecution.run({ ...input, runId: randomUUID() }, new AbortController().signal, deltaB);
    a.emit('message', { type: 'ready' }); b.emit('message', { type: 'ready' });
    a.emit('message', { type: 'delta', text: 'Alpha' }); b.emit('message', { type: 'delta', text: 'Beta' });
    controller.abort(); await cancelled; expect(a.kill).toHaveBeenCalledOnce(); expect(b.kill).not.toHaveBeenCalled();
    b.emit('message', { type: 'complete' }); await second;
    expect(deltaA.mock.calls).toEqual([['Alpha']]); expect(deltaB.mock.calls).toEqual([['Beta']]);
    const third = chatExecution.run(input, new AbortController().signal, () => {});
    expect(fake.fork).toHaveBeenCalledTimes(2); b.emit('message', { type: 'complete' }); await third;
    closeChatRuntime(); expect(b.kill).toHaveBeenCalledOnce();
  });
  it('allows a delayed first response and healthy streams longer than the old total-run cutoff', async () => {
    const delta = vi.fn(); const reasoning = vi.fn(); const run = chatExecution.run(input, new AbortController().signal, delta, undefined, reasoning);
    worker.emit('message', { type: 'ready' }); await vi.advanceTimersByTimeAsync(REPLY_IDLE_TIMEOUT_MS + 1000); expect(worker.kill).not.toHaveBeenCalled();
    worker.emit('message', { type: 'delta', text: 'Partial answer' });
    for (let i = 0; i < 5; i++) { await vi.advanceTimersByTimeAsync(REPLY_IDLE_TIMEOUT_MS - 1000); worker.emit('message', { type: 'reasoning', text: 'Progress' }); expect(worker.kill).not.toHaveBeenCalled(); }
    worker.emit('message', { type: 'complete' }); await run; expect(delta).toHaveBeenCalledWith('Partial answer'); expect(reasoning).toHaveBeenCalledTimes(5); expect(worker.kill).not.toHaveBeenCalled();
    const nextDelta = vi.fn(); const next = chatExecution.run({ ...input, secret: 'new-private-key' },new AbortController().signal,nextDelta);
    expect(fake.fork).toHaveBeenCalledOnce(); expect(worker.postMessage).toHaveBeenLastCalledWith({ type:'start',input: { ...input,secret:'new-private-key' } });
    worker.emit('message',{type:'delta',text:'Next reply'}); worker.emit('message',{type:'complete'}); await next;
    expect(nextDelta).toHaveBeenCalledWith('Next reply'); expect(delta).toHaveBeenCalledTimes(1);
  });
  it('counts provider data while optimization hides its buffered text', async () => {
    const run = chatExecution.run(input, new AbortController().signal, () => {});
    worker.emit('message', { type: 'activity', activity: 'request' });
    for (let i = 0; i < 4; i++) { await vi.advanceTimersByTimeAsync(REPLY_IDLE_TIMEOUT_MS - 1000); worker.emit('message', { type: 'activity', activity: 'data' }); }
    expect(worker.kill).not.toHaveBeenCalled(); worker.emit('message', { type: 'complete' }); await run;
  });
  it('still stops a provider that sends nothing or stalls after progress', async () => {
    const silent = chatExecution.run(input, new AbortController().signal, () => {}); const rejected = expect(silent).rejects.toThrow(REPLY_TIMEOUT_MESSAGE);
    await vi.advanceTimersByTimeAsync(FIRST_RESPONSE_TIMEOUT_MS); await rejected; expect(worker.kill).toHaveBeenCalledOnce();
    worker = new Worker(); fake.fork.mockReturnValue(worker);
    const stalled = chatExecution.run(input, new AbortController().signal, () => {}); const stopped = expect(stalled).rejects.toThrow(REPLY_TIMEOUT_MESSAGE);
    worker.emit('message', { type: 'delta', text: 'Partial answer' }); await vi.advanceTimersByTimeAsync(REPLY_IDLE_TIMEOUT_MS); await stopped;
  });
  it('suspends timeout during approval and resumes it after the tool completes', async () => {
    let finishTool!: (result: string) => void; const tool = vi.fn(() => new Promise<string>(resolve => { finishTool = resolve; }));
    const run = chatExecution.run(input, new AbortController().signal, () => {}, tool);
    worker.emit('message', { type: 'tool-request', request: { id: randomUUID(), name: 'search_sources', input: { query: 'evidence' } } });
    await vi.advanceTimersByTimeAsync(FIRST_RESPONSE_TIMEOUT_MS * 3); expect(worker.kill).not.toHaveBeenCalled(); finishTool('{}'); await vi.advanceTimersByTimeAsync(0);
    const stopped = expect(run).rejects.toThrow(REPLY_TIMEOUT_MESSAGE); await vi.advanceTimersByTimeAsync(FIRST_RESPONSE_TIMEOUT_MS); await stopped;
  });
  it('keeps cancellation immediate during an active stream', async () => {
    const controller = new AbortController(); const run = chatExecution.run(input, controller.signal, () => {}); const cancelled = expect(run).rejects.toThrow('Cancelled');
    worker.emit('message', { type: 'activity', activity: 'data' }); controller.abort(); await cancelled; expect(worker.kill).toHaveBeenCalledOnce();
  });
});


describe('foreground runtime preparation', () => {
  it('reuses the warm reserve through short replies without spawning throwaway workers', async () => {
    const first = new Worker(), spare = new Worker(); fake.fork.mockReturnValueOnce(first).mockReturnValueOnce(spare);
    warmChatRuntime('fixture');
    for (const entry of [first, spare]) { entry.emit('message', { type: 'ready' }); entry.emit('message', { type: 'warmed', model: 'fixture' }); }
    for (let i = 0; i < 10; i++) {
      const run = chatExecution.run(input, new AbortController().signal, () => {});
      first.emit('message', { type: 'complete' }); spare.emit('message', { type: 'complete' }); await run;
    }
    expect(fake.fork).toHaveBeenCalledTimes(2); expect(first.kill).not.toHaveBeenCalled(); expect(spare.kill).not.toHaveBeenCalled();
  });

  it('keeps a warmed spare after cancellation and keeps replacement startup out of the next reply', async () => {
    const first = new Worker(), spare = new Worker(), replacement = new Worker(), another = new Worker();
    fake.fork.mockReturnValueOnce(first).mockReturnValueOnce(spare).mockReturnValueOnce(replacement).mockReturnValueOnce(another);
    warmChatRuntime('fixture');
    for (const ready of [first, spare]) { ready.emit('message', { type: 'ready' }); ready.emit('message', { type: 'warmed', model: 'fixture' }); }
    const controller = new AbortController(); const running = chatExecution.run(input, controller.signal, () => {}); const stopped = expect(running).rejects.toThrow('Cancelled');
    expect(first.postMessage).toHaveBeenLastCalledWith({ type: 'start', input });
    controller.abort(); await stopped;
    const next = chatExecution.run(input, new AbortController().signal, () => {});
    expect(spare.postMessage).toHaveBeenLastCalledWith({ type: 'start', input });
    expect(replacement.postMessage.mock.calls.some(([message]) => message.type === 'start')).toBe(false);
    spare.emit('message', { type: 'complete' }); await next;
    expect(first.kill).toHaveBeenCalledOnce(); expect(spare.kill).not.toHaveBeenCalled();
    closeChatRuntime(); const forks = fake.fork.mock.calls.length; await vi.advanceTimersByTimeAsync(5000); expect(fake.fork).toHaveBeenCalledTimes(forks);
  });
  it('isolates title cancellation from reply and Work context workers', async () => {
    const title = new Worker(), reply = new Worker(); fake.fork.mockReturnValueOnce(title).mockReturnValueOnce(reply);
    const controller = new AbortController(); const background = chatExecution.run({ ...input, purpose: 'metadata' }, controller.signal, () => {}); const stopped = expect(background).rejects.toThrow('Cancelled');
    title.emit('message', { type: 'ready' });
    const foreground = chatExecution.run(input, new AbortController().signal, () => {}); reply.emit('message', { type: 'ready' }); reply.emit('message', { type: 'complete' }); await foreground;
    controller.abort(); await stopped; expect(reply.kill).not.toHaveBeenCalled();
    const measured = measureChatContext('fixture', ['Text'], new AbortController().signal);
    expect(reply.postMessage).toHaveBeenLastCalledWith({ type: 'measure', model: 'fixture', texts: ['Text'] });
    reply.emit('message', { type: 'measured', counts: [1] }); await expect(measured).resolves.toEqual([1]); expect(fake.fork).toHaveBeenCalledTimes(2);
  });
  it('warms the selected encoding after a model change and prefers it over a worker still preparing', async () => {
    const first = new Worker(), ready = new Worker(), replacement = new Worker(); fake.fork.mockReturnValueOnce(first).mockReturnValueOnce(ready).mockReturnValueOnce(replacement);
    warmChatRuntime('fixture');
    for (const entry of [first, ready]) { entry.emit('message', { type: 'ready' }); entry.emit('message', { type: 'warmed', model: 'fixture' }); }
    warmChatRuntime('anthropic/claude-sonnet');
    expect(first.postMessage).toHaveBeenLastCalledWith({ type: 'warm', model: 'anthropic/claude-sonnet' });
    ready.emit('message', { type: 'warmed', model: 'anthropic/claude-sonnet' });
    const nextInput = { ...input, model: 'anthropic/claude-sonnet' }; const run = chatExecution.run(nextInput, new AbortController().signal, () => {});
    expect(ready.postMessage).toHaveBeenLastCalledWith({ type: 'start', input: nextInput }); ready.emit('message', { type: 'complete' }); await run;
  });
  it('bounds retry attempts when an idle runtime fails to prepare', async () => {
    const list = Array.from({ length: 6 }, () => new Worker()); let i = 0; fake.fork.mockImplementation(() => list[i++]); warmChatRuntime('fixture');
    list[0].emit('exit'); list[1].emit('exit'); await vi.advanceTimersByTimeAsync(1000);
    list[2].emit('exit'); list[3].emit('exit'); await vi.advanceTimersByTimeAsync(10000);
    expect(fake.fork).toHaveBeenCalledTimes(4);
  });
});
