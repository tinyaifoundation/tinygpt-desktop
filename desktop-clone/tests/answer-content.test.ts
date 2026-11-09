import { describe, expect, it } from 'vitest';
import { answerMarkdown, chatUIToMarkdown, presentationText } from '../src/core/answer-content';
import { toolOutcomeContext } from '../src/core/context';
import type { ToolActivity } from '../src/shared/tools';

const chart = { $type: 'ChartPanel', title: 'Latency', unit: 'ms', variant: 'line', data: [{ label: 'Jan', value: 42 }, { label: 'Feb', value: 39 }], summary: 'Latency improved. [Source](https://example.com/report)' };
const tool = (ui: unknown): ToolActivity => ({ id: 'ui', conversationId: 'conversation', runId: 'run', name: 'present', summary: 'Latency', status: 'success', result: JSON.stringify({ ui }), createdAt: 1 });
describe('Portable generated answers', () => {
  it('exports chart values, units, interpretation and source links instead of opaque UI JSON', () => {
    const text = chatUIToMarkdown(chart);
    expect(text).toContain('### Latency'); expect(text).toContain('| Point | Value (ms) |');
    expect(text).toContain('| Jan | 42 |'); expect(text).toContain('| Feb | 39 |');
    expect(text).toContain('[Source](https://example.com/report)');
    expect(answerMarkdown('Measurements:', [tool(chart)])).toBe(`Measurements:\n\n${text}`);
    expect(answerMarkdown('', [tool(chart)])).toBe(text);
  });
  it('retains formatted comparison cells, metrics and follow-up text', () => {
    const text = chatUIToMarkdown({ $type: 'Col', children: [
      { $type: 'Comparison', title: 'Costs', columns: [{ label: 'Item' }, { label: 'Cost', format: { kind: 'currency', currency: 'USD', decimals: 2 } }], rows: [['A|B', 20]], summary: '**A** costs less.' },
      { $type: 'MetricGrid', metrics: [{ label: 'Total', value: '$20', delta: '-$5' }] },
      { $type: 'FollowUpGroup', suggestions: [{ label: 'Details', message: 'Show me details.' }] },
    ] });
    expect(text).toContain('A\\|B'); expect(text).toContain('$20.00'); expect(text).toContain('**Total:** $20 (-$5)');
    expect(text).toContain('Suggested next question: Show me details.');
  });
  it('omits failed or corrupt UI results and replays readable data to the model', () => {
    expect(presentationText({ ...tool(chart), status: 'error' })).toBe('');
    expect(presentationText({ ...tool(chart), result: '{broken' })).toBe('');
    const context = toolOutcomeContext([tool(chart)], true);
    expect(context).toContain('| Jan | 42 |'); expect(context).not.toContain('"$type"');
  });
  it('exports native json-render plans, schedules, callouts and diagrams as useful text', () => {
    const text = chatUIToMarkdown({ root: 'card', elements: {
      card: { type: 'Card', props: { title: 'Launch', description: 'A reviewable plan.' }, children: ['plan', 'schedule', 'insight', 'diagram'] },
      plan: { type: 'Checklist', props: { title: 'Tasks', items: [{ text: 'Review', checked: true }, { text: 'Ship', detail: 'After review' }] }, children: [] },
      schedule: { type: 'Timeline', props: { title: 'Schedule', items: [{ title: 'Release', date: 'Friday' }] }, children: [] },
      insight: { type: 'Callout', props: { body: 'Use [the source](https://example.com).' }, children: [] },
      diagram: { type: 'Diagram', props: { code: 'graph LR\nA --> B' }, children: [] },
    } });
    expect(text).toContain('A reviewable plan.'); expect(text).toContain('- [x] Review');
    expect(text).toContain('- [ ] Ship — After review'); expect(text).toContain('1. Friday: Release');
    expect(text).toContain('[the source](https://example.com)'); expect(text).toContain('```mermaid\ngraph LR\nA --> B\n```');
    expect(text).not.toContain('"elements"');
  });
});
