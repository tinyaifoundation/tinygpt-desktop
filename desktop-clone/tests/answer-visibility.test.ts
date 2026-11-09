import { describe, expect, it } from 'vitest';
import { hasStartedAnswer, holdAnswerText } from '../src/core/answer-visibility';
import type { ActiveRun } from '../src/shared/chat';

describe('answer visibility during tool transitions', () => {
  const message = { runId: 'run', status: 'streaming' as const };
  const active: ActiveRun = { conversationId: 'chat', runId: 'run', textLane: 'unclassified', phase: 'prose' };
  it('holds undecided and progress text across a tool notification before text is cleared', () => {
    expect(holdAnswerText(message, active)).toBe(true);
    expect(holdAnswerText(message, { ...active, textLane: 'progress', phase: 'tool' })).toBe(true);
    expect(holdAnswerText(message, { ...active, textLane: 'progress', phase: 'waiting' })).toBe(true);
    expect(holdAnswerText(message, { ...active, textLane: 'answer', phase: 'tool-input' })).toBe(true);
  });
  it('shows identified answers and preserves stopped/failed/completed partial text and other runs', () => {
    expect(holdAnswerText(message, { ...active, textLane: 'answer', phase: 'answer' })).toBe(false);
    for (const status of ['complete', 'cancelled', 'error', 'interrupted'] as const) expect(holdAnswerText({ ...message, status }, active)).toBe(false);
    expect(holdAnswerText(message, { ...active, runId: 'other' })).toBe(false);
    expect(holdAnswerText(message)).toBe(false);
  });
  it('ends work at actual identified answer text, preserving continued work and undecided tool preludes', () => {
    const reply = { ...message, text: 'Saved partial answer' };
    expect(hasStartedAnswer(reply, { ...active, phase: 'connecting', textLane: undefined })).toBe(false);
    expect(hasStartedAnswer(reply, active)).toBe(false);
    expect(hasStartedAnswer(reply, { ...active, phase: 'answer', textLane: 'answer' })).toBe(true);
    expect(hasStartedAnswer(reply, { ...active, phase: 'answer', textLane: undefined })).toBe(true);
    expect(hasStartedAnswer({ ...reply, text: '' }, { ...active, phase: 'answer', textLane: 'answer' })).toBe(false);
    expect(hasStartedAnswer(reply, { ...active, phase: 'tool-input', textLane: 'answer' })).toBe(false);
    expect(hasStartedAnswer({ ...reply, status: 'complete' }, active)).toBe(true);
  });
  it('keeps already published Chat answers visible while preparing a widget or doing later work', () => {
    const reply = { ...message, text: 'The substantive answer.' };
    for (const phase of ['tool-input', 'tool', 'waiting', 'thinking'] as const) {
      const retained = { ...active, phase, textLane: 'progress' as const, hasVisibleAnswer: true };
      expect(holdAnswerText(reply, retained)).toBe(false);
      expect(hasStartedAnswer(reply, retained)).toBe(true);
    }
  });
});
