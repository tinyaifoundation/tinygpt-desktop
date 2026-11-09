import type { ChatWorkerInput } from '../shared/chat';
import { builtInModelId } from '../shared/managed-local';
import { effortPayload } from './effort';
import { workOutputBudget } from './work-history-import';

/** Pro-only Work allowance. Keep native effort (including Max/xhigh) and the
 * configured total response cap; leave at least half for tool arguments/results.
 * MiniCPM's unfinished-thinking behavior must not inherit this policy. */
export function workEffortPayload(payload: Record<string, unknown>, input: ChatWorkerInput, ceiling: number) {
  const total = workOutputBudget(payload, ceiling);
  const result = effortPayload(payload, input, total);
  if (input.provider !== 'local' || input.protocol !== 'openai-compatible' || builtInModelId(input.model) !== 'pro' || input.reasoning?.kind !== 'llamacpp' || !input.effort || input.effort === 'instant') return result;
  const target = { low: 1024, medium: 2048, high: 4096, max: 8192 }[input.effort];
  // Enabled after the isolated Pro runtime smoke verifies the native boundary.
  if (process.env.TINYGPT_TEST_PRO_WORK_BUDGET === '1') result.reasoning_budget_tokens = Math.max(1, Math.min(target, Math.floor(total / 2)));
  return result;
}
