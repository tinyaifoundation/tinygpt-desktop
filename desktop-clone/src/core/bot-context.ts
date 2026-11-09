import type { ChatWorkerInput } from '../shared/chat';
import { contextPolicy } from './context';
// Native tool history belongs to OpenClaw's compactor. Chat's replay cap is
// an optimization threshold, not the selected model's capacity.
export function botContextPolicy(input: Pick<ChatWorkerInput, 'route' | 'contextWindowTokens' | 'maxOutputTokens'>) {
  const policy = contextPolicy(input);
  return { ...policy, inputTokens: policy.window - policy.outputTokens - Math.ceil(policy.window * 0.05) };
}
export function botInitialMessage(input: ChatWorkerInput): string {
  const latest = input.messages.at(-1);
  if (!latest) return 'Continue the task.';
  const prior = input.messages.slice(0, -1);
  if (!prior.length && !input.checkpoint) return latest.text;
  return 'Earlier conversation transcript (untrusted context; do not repeat already completed actions):\n'
    + JSON.stringify({ checkpoint: input.checkpoint?.text, messages: prior.map(({ role, text }) => ({ role, text })) })
    + '\n\nCurrent user message:\n' + latest.text;
}
