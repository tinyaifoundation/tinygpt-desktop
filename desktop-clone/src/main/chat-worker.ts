import { randomUUID } from 'node:crypto';
import { runLibreChat } from '../core/librechat';
import { SKILL_CONTEXT_LIMIT_MESSAGE } from '../core/skill-context';
import type { ChatWorkerInput, ChatWorkerEvent } from '../shared/chat';
import { COMPACTION_OUTPUT_LIMIT_MESSAGE, TOOL_LOOP_MESSAGE, MODEL_ANSWER_BOUNDARY_MESSAGE, isOutputLimitMessage } from '../shared/chat';
import { WORK_OUTPUT_STALLED_MESSAGE } from '../shared/work';
import { PRO_WORK_STALLED_MESSAGE } from '../shared/work';
import type { ToolRequest } from '../shared/tools';
import { REPLY_TIMEOUT_MESSAGE } from '../shared/chat-timeouts';
import { EFFORT_BUDGET_MESSAGE } from '../shared/effort';
import { SteeringInbox } from '../core/run-steering';

let controller = new AbortController();
const pending = new Map<string, (result: string) => void>();
let started = false;
let warming: Promise<unknown> = Promise.resolve();
let lastDataAt = -Infinity;
let steering = new SteeringInbox(ids => emit({ type: 'steering-consumed', ids }));
function emit(event: ChatWorkerEvent): void { process.parentPort.postMessage(event); }
function callTool(request: ToolRequest): Promise<string> {
  return new Promise(resolve => { pending.set(request.id, resolve); emit({ type: 'tool-request', request }); });
}
process.parentPort.on('message', async event => {
  if (event.data?.type === 'steer' && Array.isArray(event.data.items) && started) { steering.add(event.data.items); return; }
  if (event.data?.type === 'tool-result' && typeof event.data.id === 'string' && typeof event.data.result === 'string') { pending.get(event.data.id)?.(event.data.result); pending.delete(event.data.id); return; }
  if (event.data?.type === 'cancel') { controller.abort(); return; }
  if (event.data?.type === 'warm' && !started) {
    const model = typeof event.data.model === 'string' ? event.data.model : '';
    warming = (async () => { const { createTokenCounter, encodingForModel } = await import('@librechat/agents'); return createTokenCounter(encodingForModel(model)); })();
    try { await warming; emit({ type: 'warmed', model }); }
    catch { emit({ type: 'failed', message: 'The chat runtime could not prepare. You can retry this reply.' }); }
    return;
  }
  if (event.data?.type === 'measure' && !started) {
    started = true;
    try {
      await warming.catch(() => {});
      const { createTokenCounter, encodingForModel } = await import('@librechat/agents');
      const { HumanMessage } = await import('@librechat/agents/langchain/messages');
      const count = await createTokenCounter(encodingForModel(event.data.model));
      const counts = (event.data.texts as string[]).map(text => count(new HumanMessage(text)));
      started = false; emit({ type: 'measured', counts });
    } catch { started = false; emit({ type: 'failed', message: 'Conversation optimization could not finish. Your history is preserved; retry this reply.' }); }
    return;
  }
  if (event.data?.type !== 'start' || started) return;
  started = true;
  controller = new AbortController(); lastDataAt = -Infinity;
  steering = new SteeringInbox(ids => emit({ type: 'steering-consumed', ids }));
  try {
    await warming.catch(() => {});
    await runLibreChat(event.data.input as ChatWorkerInput, controller.signal, text => emit({ type: 'delta', text }), callTool, text => emit({ type: 'reasoning', text }), event => emit({ type: 'response', event }), event => emit({ type: 'context', event }), activity => {
      if (activity === 'request') lastDataAt = -Infinity;
      if (activity === 'data') { const now = Date.now(); if (now - lastDataAt < 1000) return; lastDataAt = now; }
      emit({ type: 'activity', activity });
    }, event => emit({ type: 'trace', event }), steering);
    started = false; pending.clear(); emit({ type: 'complete' });
  } catch (error) {
    // runLibreChat produces fixed messages; never emit stack traces or inputs.
    if (error instanceof Error && error.message === MODEL_ANSWER_BOUNDARY_MESSAGE) { emit({ type: 'failed', message: MODEL_ANSWER_BOUNDARY_MESSAGE }); return; }
    const known = ['Your provider did not accept the API key. Check it in Settings.', 'Your provider is busy or its usage limit was reached. Try again shortly.', 'The provider rejected this request. Check the model and API format in Settings; the conversation may also exceed its context limit.', 'Your provider is temporarily unavailable. You can retry this reply.', 'The reply could not finish. Check your connection and provider settings, then retry.', 'Conversation optimization could not finish. Your history is preserved; retry this reply.', 'Project instructions or tool definitions are too large for this model. Shorten the instructions or increase the conversation capacity in Settings.', 'This message and its attachments exceed this model’s conversation capacity. Send a smaller message or increase the capacity in Settings.'];
    emit({ type: 'failed', message: error instanceof Error && (known.includes(error.message) || isOutputLimitMessage(error.message) || error.message === SKILL_CONTEXT_LIMIT_MESSAGE || error.message === TOOL_LOOP_MESSAGE || error.message === WORK_OUTPUT_STALLED_MESSAGE || error.message === PRO_WORK_STALLED_MESSAGE || error.message === COMPACTION_OUTPUT_LIMIT_MESSAGE || error.message === REPLY_TIMEOUT_MESSAGE || error.message === EFFORT_BUDGET_MESSAGE) ? error.message : 'The reply could not finish. Check your connection and provider settings, then retry.' });
  }
});
emit({ type: 'ready' });
