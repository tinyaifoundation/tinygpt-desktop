import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { CHECKPOINT_INSTRUCTIONS, contextPolicy, fadeToolResult, prepareConversationContext } from '../src/core/context';
import type { ChatWorkerInput, ContextEvent } from '../src/shared/chat';

const count = (text: string) => Math.ceil(text.length / 4);
function input(messages: ChatWorkerInput['messages']): ChatWorkerInput {
  return { runId: randomUUID(), route: 'byok', endpoint: 'https://example.com/v1', protocol: 'openai-compatible', provider: 'custom', model: 'fixture', instructions: 'Helpful.', messages };
}
const message = (role: 'user' | 'assistant', text: string) => ({ id: randomUUID(), role, text });

describe('automatic conversation context', () => {
  it('includes structured Work outcomes in checkpoints instead of losing actions behind final prose', async () => {
    const operationId = randomUUID();
    const messages: ChatWorkerInput['messages'] = [message('user', 'Preserve the task'), { ...message('assistant', 'Older reasoning. '.repeat(10000)), operations: [{ id: operationId, name: 'ext_mutation', input: { record: 'fixture' }, result: '{"code":"OUTCOME_UNKNOWN"}', status: 'unknown', signature: 'fixture' }] }, message('user', 'Recent request'), message('assistant', 'Recent result'), message('user', 'Continue the task')];
    const batches: string[] = [];
    await prepareConversationContext(input(messages), count, 500, new AbortController().signal, async transcript => { batches.push(transcript); return 'Preserve the original task. An earlier mutation has an unknown outcome; check it before retrying.'; });
    expect(batches.join('\n')).toContain(operationId); expect(batches.join('\n')).toContain('OUTCOME_UNKNOWN'); expect(batches.join('\n')).toContain('historical evidence');
  });
  it('budgets unknown local capacity conservatively and limits large-window replay', () => {
    expect(contextPolicy({ route: 'local' }).inputTokens).toBeLessThan(8192);
    expect(contextPolicy({ route: 'byok', contextWindowTokens: 1000000 }).inputTokens).toBe(64000);
    expect(contextPolicy({ route: 'local', contextWindowTokens: 4096 }).outputTokens).toBe(1024);
    expect(contextPolicy({ route: 'byok' }).outputTokens).toBe(8192);
    expect(contextPolicy({ route: 'byok', contextWindowTokens: 128000 }).outputTokens).toBe(16384);
    expect(contextPolicy({ route: 'byok', maxOutputTokens: 12000 }).outputTokens).toBe(12000);
    expect(contextPolicy({ route: 'byok', maxOutputTokens: 128 })).toMatchObject({ summaryTokens: 1500, summaryOutputTokens: 8192 });
    const constrained = contextPolicy({ route: 'local', contextWindowTokens: 4096, maxOutputTokens: 32000 });
    expect(constrained.inputTokens).toBeGreaterThanOrEqual(1024);
    expect(constrained.inputTokens + constrained.outputTokens).toBeLessThan(4096);
  });
  it('does not call the summarizer for a short conversation', async () => {
    const messages = [message('user', 'Hello'), message('assistant', 'Hello!'), message('user', 'What is 2+2?')];
    const result = await prepareConversationContext(input(messages), count, 500, new AbortController().signal, async () => { throw new Error('Unexpected charge'); });
    expect(result.messages).toBe(messages); expect(result.summary).toBe('');
  });
  it('uses a configured large window without an unnecessary summary request', async () => {
    const messages = [message('user', 'Keep the whole task'), message('assistant', 'x'.repeat(90000)), message('user', 'Write the file')];
    const result = await prepareConversationContext({ ...input(messages), contextWindowTokens: 1048576 }, count, 5000, new AbortController().signal, async () => { throw new Error('Unnecessary summarization'); });
    expect(result.messages).toBe(messages); expect(result.summary).toBe('');
    expect(contextPolicy({ route: 'byok', contextWindowTokens: 32768 }).inputTokens).toBeLessThan(32768 - 8192);
  });
  it('recovers oversized history in bounded batches and retains the latest turns', async () => {
    const messages = [message('user', 'Remember BLUEBIRD'), message('assistant', 'Evidence\n'.repeat(50000)), message('user', 'Recent question'), message('assistant', 'Recent answer'), message('user', 'Current request')];
    const events: ContextEvent[] = []; const batches: string[] = [];
    const result = await prepareConversationContext(input(messages), count, 1000, new AbortController().signal, async (text, previous) => { batches.push(text); expect(previous.length).toBeLessThan(6000); return 'Goal: BLUEBIRD. Evidence reviewed. No actions repeated.'; }, event => events.push(event));
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.every(text => count(text) + 1500 + count(CHECKPOINT_INSTRUCTIONS) + 256 <= 16000)).toBe(true);
    expect(result.messages.map(message => message.text)).toEqual(['Recent question', 'Recent answer', 'Current request']);
    const checkpoints = events.filter(event => event.type === 'checkpoint');
    expect(checkpoints.at(-1)?.checkpoint.throughMessageId).toBe(messages[1].id);
    expect(events.at(-1)?.type).toBe('optimized'); expect(messages[1].text.length).toBe(450000);
    expect(result.throughMessageId).toBe(messages[1].id);
  });
  it('never commits a partially summarized message after failure', async () => {
    const messages = [message('user', 'A goal'), message('assistant', 'Very large result '.repeat(10000)), message('user', 'Next')];
    const events: ContextEvent[] = []; let calls = 0;
    await expect(prepareConversationContext(input(messages), count, 500, new AbortController().signal, async () => { if (++calls === 3) throw new Error('offline'); return 'Checkpoint'; }, event => events.push(event))).rejects.toThrow('offline');
    expect(events.filter(event => event.type === 'checkpoint').map(event => event.checkpoint.throughMessageId)).toEqual([messages[0].id]);
    expect(events.at(-1)?.type).toBe('optimization-failed');
  });
  it('does not commit a summary arriving after cancellation', async () => {
    const controller = new AbortController(); const events: ContextEvent[] = [];
    await expect(prepareConversationContext(input([message('user', 'Old'), message('assistant', 'x'.repeat(100000)), message('user', 'New')]), count, 500, controller.signal, async () => { controller.abort(); return 'Late checkpoint'; }, event => events.push(event))).rejects.toThrow();
    expect(events.some(event => event.type === 'checkpoint')).toBe(false);
  });
  it('reports a genuinely oversized current request without silently cutting it', async () => {
    const request = input([message('user', 'x'.repeat(100000))]);
    await expect(prepareConversationContext(request, count, 500, new AbortController().signal, async () => '')).rejects.toThrow('attachments exceed');
    expect(request.messages[0].text.length).toBe(100000);
  });
  it('keeps the head and tail of old tool results', () => {
    const result = fadeToolResult('START' + 'x'.repeat(3000) + 'END', 300);
    expect(result.length).toBeLessThanOrEqual(300); expect(result).toContain('START'); expect(result).toContain('END');
  });
  it('uses the supplied multimodal token count before accepting a current request', async () => {
    const request = input([{ ...message('user', 'Inspect these images'), images: ['data:image/jpeg;base64,fixture'] }]);
    await expect(prepareConversationContext(request, count, 500, new AbortController().signal, async () => '', undefined, () => 20000)).rejects.toThrow('attachments exceed');
  });
});
