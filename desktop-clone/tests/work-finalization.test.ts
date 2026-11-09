import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { runLibreChat } from '../src/core/librechat';
import { HistoryStore } from '../src/main/history';
import { WorkTaskController } from '../src/main/work-tasks';

it.each(['completed', 'blocked', 'waiting'] as const)('accepts an optional %s outcome without evidence repair or another model request', async status => {
  const h = new HistoryStore(':memory:'), chat = h.createConversation(null, 'code'), turn = h.startTurn(chat.id, 'Report the result', 'local');
  const task = h.workTasks.begin(chat.id, turn.assistantId, turn.runId, 'Report the result'), controller = new WorkTaskController(h.workTasks, task.id);
  const id = randomUUID(); h.workTasks.startOperation(task.id, id, 'write_file', { path: '/invalid/abandoned.html' }); h.workTasks.finishOperation(task.id, id, '{"error":"Invalid path"}');
  let requests = 0, output = '';
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {} requests++;
    const delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'finish', type: 'function', function: { name: 'work_finish', arguments: JSON.stringify({ status, answer: 'The actual result and limitations.' }) } }] };
    const frame = (delta: unknown, finish_reason: string | null) => 'data: ' + JSON.stringify({ id: 'done', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(frame(delta, null) + frame({}, 'tool_calls') + 'data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await runLibreChat({ mode: 'code', workTask: task, runId: turn.runId, route: 'local', provider: 'local', protocol: 'openai-compatible', endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, model: 'fixture', tools: true, contextWindowTokens: 65536, instructions: 'Report the result.', messages: [{ role: 'user', text: 'Report the result.' }] }, AbortSignal.timeout(20000), text => { output += text; }, async request => controller.update(request.name, request.input), undefined, undefined, undefined, undefined, undefined, undefined, async event => controller.decision(event));
    expect(requests).toBe(1); expect(output).toBe('The actual result and limitations.'); expect(controller.task.status).toBe(status);
    expect(controller.task.criteria).toEqual([]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); h.close(); }
}, 30000);
