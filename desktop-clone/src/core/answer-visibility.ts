import type { ActiveRun, ChatMessage } from '../shared/chat';

// A tool notification can arrive before the next saved text flush. The old
// prelude must stay hidden after its lane changes from undecided to progress.
export function holdAnswerText(message: Pick<ChatMessage, 'status' | 'runId'>, active?: ActiveRun): boolean {
  return message.status === 'streaming' && !!active && message.runId === active.runId
    && !active.hasVisibleAnswer
    && (active.textLane === 'unclassified' || active.textLane === 'progress' || active.phase === 'tool-input');
}

/** A restored partial answer alone does not end work on a continued run. */
export function hasStartedAnswer(message: Pick<ChatMessage, 'status' | 'runId' | 'text'>, active?: ActiveRun): boolean {
  if (!message.text.trim() || holdAnswerText(message, active)) return false;
  return message.status !== 'streaming' || !!active && message.runId === active.runId && (active.hasVisibleAnswer || active.phase === 'answer' || active.textLane === 'answer');
}
