import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { WorkResponse } from '../src/renderer/components/WorkResponse';
import type { WorkActivity } from '../src/shared/chat';
import { WorkOutcomeCard } from '../src/renderer/components/WorkOutcomeCard';
import type { WorkTask } from '../src/shared/work';

it('starts collapsed when an answer is streaming and omits the completed status label', () => {
  const html = renderToStaticMarkup(createElement(WorkResponse, { activity: [], tools: [], reasoning: '', createdAt: 100, running: true, status: 'streaming', answerStarted: true, children: 'Streaming answer' }));
  expect(html).toContain('aria-expanded="false"'); expect(html).toContain('Streaming answer');
  expect(renderToStaticMarkup(createElement(WorkOutcomeCard, { task: { status: 'completed' } as WorkTask }))).toBe('');
  expect(renderToStaticMarkup(createElement(WorkOutcomeCard, { task: { status: 'awaiting-input' } as WorkTask }))).toContain('Waiting for your answer');
});

it('renders compaction and temporary steering in the Work history, removing steering when the turn ends', () => {
  const activity: WorkActivity[] = [
    { id: 'before', runId: 'run', kind: 'prose', text: 'Before optimization.', startedAt: 100 },
    { id: 'steer', runId: 'run', kind: 'steering', messageId: 'user', text: 'Use blue.', startedAt: 250 },
    { id: 'after', runId: 'run', kind: 'prose', text: 'After optimization.', startedAt: 300 },
  ];
  const props = { activity, tools: [], reasoning: '', createdAt: 100, contexts: [{ id: 'compact', runId: 'run', status: 'complete' as const, createdAt: 200 }] };
  const active = renderToStaticMarkup(createElement(WorkResponse, { ...props, status: 'streaming', running: true, children: 'Answer' }));
  expect(active.match(/data-slot="context-optimization"/g)).toHaveLength(1);
  expect(active.indexOf('Before optimization.')).toBeLessThan(active.indexOf('Optimized the conversation'));
  expect(active.indexOf('Optimized the conversation')).toBeLessThan(active.indexOf('Use blue.'));
  expect(active.indexOf('Use blue.')).toBeLessThan(active.indexOf('After optimization.'));
  // Interrupted history remains expanded, but its transient user steer is gone.
  const ended = renderToStaticMarkup(createElement(WorkResponse, { ...props, status: 'interrupted', running: false, children: 'Answer' }));
  expect(ended).toContain('Optimized the conversation'); expect(ended).not.toContain('Use blue.');
  const complete = renderToStaticMarkup(createElement(WorkResponse, { ...props, status: 'complete', running: false, children: 'Answer' }));
  expect(complete).not.toContain('Use blue.');
});

it('leaves failed Work messaging to the actionable error alert, preserving other outcomes', () => {
  const props = { activity: [], tools: [], reasoning: '', createdAt: 100, running: false, children: 'Saved work', task: { status: 'paused', summary: 'Failure explanation' } as WorkTask };
  const failed = renderToStaticMarkup(createElement(WorkResponse, { ...props, status: 'error' }));
  expect(failed).toContain('Saved work');
  expect(failed).not.toContain('work-outcome-card');
  const paused = renderToStaticMarkup(createElement(WorkResponse, { ...props, status: 'interrupted' }));
  expect(paused).not.toContain('work-outcome-card');
  const blocked = renderToStaticMarkup(createElement(WorkResponse, { ...props, status: 'complete', task: { ...props.task, status: 'blocked' } }));
  expect(blocked).toContain('work-outcome-card');
});
