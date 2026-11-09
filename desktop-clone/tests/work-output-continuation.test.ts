import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { runLibreChat } from '../src/core/librechat';
import { HistoryStore } from '../src/main/history';

it.each(['prose', 'reasoning', 'tool', 'after-action'])('stops a %s output cutoff without restarting the graph or replaying an action', async kind => {
  const h = new HistoryStore(':memory:'), c = h.createConversation(null, 'code'), turn = h.startTurn(c.id, 'Create a file', 'local');
  const task = h.workTasks.begin(c.id, turn.assistantId, turn.runId, 'Create a file'); let requests = 0, actions = 0;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {} requests++;
    const action = kind === 'after-action' && requests === 1;
    const delta = action ? { role: 'assistant', tool_calls: [{ index: 0, id: 'saved', type: 'function', function: { name: 'write_file', arguments: '{"path":"saved.txt","content":"saved"}' } }] } : kind === 'tool' ? { role: 'assistant', tool_calls: [{ index: 0, id: 'partial', type: 'function', function: { name: 'write_file', arguments: '{"path":"unfinished' } }] } : { role: 'assistant', ...(kind === 'reasoning' ? { reasoning_content: 'Thinking.' } : { content: 'Partial answer.' }) };
    const frame = (delta: unknown, finish_reason: string | null) => 'data: ' + JSON.stringify({ id: 'cutoff-' + requests, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(frame(delta, null) + frame({}, action ? 'tool_calls' : 'length') + 'data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await expect(runLibreChat({ mode: 'code', workTask: task, runId: randomUUID(), route: 'local', provider: 'local', protocol: 'openai-compatible', model: 'fixture', endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, tools: true, contextWindowTokens: 65536, instructions: 'Create a file.', messages: [{ role: 'user', text: 'Create a file.' }] }, AbortSignal.timeout(20000), () => {}, async request => { if (request.validationError) return request.validationError; actions++; return '{"action":"created"}'; })).rejects.toThrow(/output limit/i);
    expect(requests).toBe(kind === 'after-action' ? 2 : 1); expect(actions).toBe(kind === 'after-action' ? 1 : 0);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); h.close(); }
}, 30000);
