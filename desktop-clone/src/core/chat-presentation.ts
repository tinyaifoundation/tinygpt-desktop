import type { ActiveRun, ChatMessage } from '../shared/chat';
import { hasStartedAnswer, holdAnswerText } from './answer-visibility';
import { toolProgressText } from '../shared/tool-display';

/** Presentation only: a single replaceable progress slot, independent of the
 * tool disclosure. Provider-classified answer text retains its streaming lane. */
export function chatPresentation(message: Pick<ChatMessage,'text'|'status'|'runId'>, active?: ActiveRun, previousAnswer = '', visualAnswerStarted = false) {
  const answerStarted = visualAnswerStarted || hasStartedAnswer(message,active);
  const live = message.status==='streaming'&&!!active&&message.runId===active.runId;
  const answerLane = live&&(active.phase==='answer'||active.hasVisibleAnswer||active.textLane==='answer');
  const candidate = previousAnswer && message.text.startsWith(previousAnswer) ? message.text.slice(previousAnswer.length) : message.text;
  const progress = live&&!answerStarted&&!answerLane ? toolProgressText(active.prose??(holdAnswerText(message,active)?candidate:'')) : '';
  return {progress,answerStarted};
}
