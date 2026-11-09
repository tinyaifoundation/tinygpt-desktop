import { expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { runLibreChat } from '../src/core/librechat';
import { HistoryStore } from '../src/main/history';

it.each(['tinygpt-included', 'tinygpt-pro'])('lets %s give a final answer without reasoning-control requests or forced continuation', async model => {
  const history = new HistoryStore(':memory:'), chat = history.createConversation(null, 'code'), turn = history.startTurn(chat.id, 'Explain the result', 'local');
  const task = history.workTasks.begin(chat.id, turn.assistantId, turn.runId, 'Explain the result');
  let requests = 0, output = ''; const control = vi.fn(async () => ({ action: 'continue' as const }));
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests++;
    expect(req.url).toBe('/v1/chat/completions'); expect(body.reasoning_control).toBeUndefined();
    const frame = (delta: unknown, finish_reason: string | null) => 'data: ' + JSON.stringify({ id: 'plain', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(frame({ role: 'assistant', reasoning_content: 'A bounded provider response. '.repeat(1000) }, null) + frame({ content: 'Finished.' }, null) + frame({}, 'stop') + 'data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await runLibreChat({ mode: 'code', workTask: task, runId: randomUUID(), route: 'local', provider: 'local', protocol: 'openai-compatible', model, effort: 'max', reasoning: { kind: 'llamacpp', efforts: ['xhigh'], canDisable: true }, endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, contextWindowTokens: 65536, maxOutputTokens: 16384, tools: true, instructions: 'Explain the result.', messages: [{ role: 'user', text: 'Explain the result.' }] }, AbortSignal.timeout(20000), text => { output += text; }, async () => '{}', undefined, undefined, undefined, undefined, undefined, undefined, control);
    expect(output).toBe('Finished.'); expect(requests).toBe(1); expect(control).not.toHaveBeenCalled();
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); history.close(); }
}, 30000);
