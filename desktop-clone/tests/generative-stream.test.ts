import { describe, expect, it, vi, afterEach } from 'vitest';
import { GenerativeStream, previewChatUI } from '../src/core/generative-stream';
import { generativeParts } from '../src/core/generative-parts';
import type { ResponseEvent } from '../src/shared/chat';
const spec = (value: string) => ({ root: 'text', elements: { text: { type: 'Text', props: { value }, children: [] } } });
afterEach(() => vi.restoreAllMocks());
describe('streamed json-render outputs', () => {
  it('previews partial props and complete rows while omitting unfinished or unsafe nodes', () => {
    const partial = '{"root":"card","elements":{"card":{"type":"Card","props":{"title":"Budget"},"children":["text","pending"]},"text":{"type":"Text","props":{"value":"First';
    expect(previewChatUI(partial)).toMatchObject({ root: 'card', elements: { card: { children: ['text'] }, text: { props: { value: 'First' } } } });
    expect(previewChatUI('{"root":"chart","elements":{"chart":{"type":"ChartPanel","props":{"title":"Incomplete"')).toBeUndefined();
    const table = { root: 't', elements: { t: { type: 'Table', props: { columns: [{ label: 'Name' }, { label: 'Cost' }], rows: [['A', 1], ['B']] }, children: [] } } };
    expect(previewChatUI(JSON.stringify(table))).toMatchObject({ elements: { t: { props: { rows: [['A', 1]] } } } });
    expect(previewChatUI(JSON.stringify({ root: 't', elements: { t: { type: 'Text', props: { value: 'Unsafe', onClick: 'execute' }, children: [] } } }))).toBeUndefined();
    expect(previewChatUI('x'.repeat(80001))).toBeUndefined();
  });
  it('retains provider IDs for parallel presentations and clears unclaimed previews', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const events: ResponseEvent[] = []; const stream = new GenerativeStream(event => events.push(event));
    stream.delta('step', [{ index: 0, id: 'provider-a', name: 'present', args: JSON.stringify(spec('Hello')) }, { index: 1, id: 'provider-b', name: 'present', args: JSON.stringify(spec('Other')) }]);
    expect(events).toHaveLength(2);
    expect(stream.claim(spec('Hello'), 'provider-a')).toBe((events[0] as { id: string }).id);
    stream.clear();
    expect(events[2]).toMatchObject({ type: 'ui-preview', id: (events[1] as { id: string }).id, ui: null });
  });
  it('does not execute partial arguments or claim a successful receipt for previews', () => {
    const events: ResponseEvent[] = []; const stream = new GenerativeStream(event => events.push(event));
    stream.delta('step', [{ name: 'calculate', args: '{"expression":"1+1"}' }]); expect(events).toHaveLength(0);
    const part = generativeParts([{ id: 'ui', runId: 'run', conversationId: 'chat', name: 'present', summary: '', createdAt: 1, status: 'running', result: JSON.stringify({ ui: spec('Draft') }) }])[0];
    expect(part).toMatchObject({ type: 'tool-call', toolCallId: 'ui', args: spec('Draft') }); expect(part).not.toHaveProperty('result');
  });
});
