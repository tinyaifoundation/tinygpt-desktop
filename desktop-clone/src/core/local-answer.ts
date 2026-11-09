import { MODEL_ANSWER_BOUNDARY_MESSAGE } from '../shared/chat';
/** Check structural thinking markers, while allowing documentation in code or
 * inline quotations. Never guess whether ordinary prose is hidden reasoning. */
export function validateLocalAnswer(text: string): string {
  const prose = text.replace(/```[\s\S]*?(?:```|$)/g, '').replace(/`[^`\n]*`/g, '');
  if (/^\s*<think>/i.test(prose) || /^[\t ]*<\/?think>[\t ]*$/im.test(prose)) throw new Error(MODEL_ANSWER_BOUNDARY_MESSAGE);
  return text;
}
