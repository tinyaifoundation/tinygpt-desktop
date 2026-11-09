import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { toolDefinitions } from '../src/shared/tools';
import { runLibreChat, scopedFetch } from '../src/core/librechat';
import type { ChatWorkerInput, ResponseEvent } from '../src/shared/chat';
import { OUTPUT_LIMIT_MESSAGE, TOOL_OUTPUT_LIMIT_MESSAGE, COMPACTION_OUTPUT_LIMIT_MESSAGE, MODEL_ANSWER_BOUNDARY_MESSAGE } from '../src/shared/chat';
import { HistoryStore } from '../src/main/history';
import { ToolBroker } from '../src/main/tool-broker';
import { defaultSettings } from '../src/shared/config';
import type { BrowserController } from '../src/main/browser';
import type { ProjectFiles } from '../src/main/files';
import { SteeringInbox } from '../src/core/run-steering';
import { readFileSync } from 'node:fs';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
});
async function fixture(handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture address.');
  return `http://127.0.0.1:${address.port}/v1`;
}
function input(endpoint: string, protocol: ChatWorkerInput['protocol'] = 'openai-compatible'): ChatWorkerInput {
  return { runId: randomUUID(), endpoint, protocol, provider: 'custom', model: 'fixture-model', secret: 'fixture-key', route: 'byok', instructions: 'Answer in short sentences.', messages: [{ role: 'user', text: 'Hello fixture' }] };
}
function chunk(text: string, finish: boolean = false) {
  return { id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta: finish ? {} : { role: 'assistant', content: text }, finish_reason: finish ? 'stop' : null }] };
}

describe('the actual LibreChat harness', () => {
  it('delivers the recorded OpenRouter Image target through the provider boundary', async () => {
    const recorded = readFileSync(new URL('./fixtures/openrouter-browser-snapshot.json', import.meta.url), 'utf8');
    let calls = 0; let delivered: any;
    const endpoint = await fixture(async (request, response) => {
      let raw = ''; for await (const part of request) raw += part;
      const body = JSON.parse(raw), n = ++calls, first = n <= 2;
      if (n === 3) {
        delivered = body.messages.filter((message: any) => message.role === 'tool').at(-1).content;
      }
      const delta = first ? { role: 'assistant', tool_calls: [{ index: 0, id: 'rankings-' + n, type: 'function', function: n === 1 ? { name: 'load_tools', arguments: '{"group":"browser","query":"browser_open"}' } : { name: 'browser_open', arguments: '{"url":"https://openrouter.ai/rankings"}' } }] } : { role: 'assistant', content: 'Image target is available.' };
      response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(`data: ${JSON.stringify({ ...chunk(''), id: 'rankings-' + n, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...chunk('', true), id: 'rankings-' + n, choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
    await runLibreChat({ ...input(endpoint), mode: 'chat', tools: true, contextWindowTokens: 64000 }, new AbortController().signal, () => {}, async request => { if (request.validationError) throw Error(request.validationError); return request.name === 'load_tools' ? '{"enabled":"browser","query":"browser_open"}' : recorded; });
    expect(calls).toBe(3);
    expect(delivered.length).toBeLessThanOrEqual(12000);
    expect(JSON.parse(delivered)).toMatchObject({ tabId: '11111111-1111-4111-8111-111111111111', targets: { total: 150 } });
    expect(JSON.parse(delivered).elements).toContainEqual({ id: 't23', role: 'tab', label: 'Image' });
  }, 30000);
  it.each([false, true])('accepts an answer followed by a presentation with an optional closing text (closing=%s)', async closing => {
    let calls = 0; let output = '';
    const endpoint = await fixture(async (request, response) => {
      for await (const _part of request) { /* consume */ }
      const first = ++calls === 1;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (first) {
        response.write('data: ' + JSON.stringify(chunk('The substantive feasibility analysis.')) + '\n\n');
        response.write('data: ' + JSON.stringify({ ...chunk(''), choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'follow-ups', type: 'function', function: { name: 'present', arguments: '{"root":"text","elements":{"text":{"type":"Text","props":{"value":"Next questions"},"children":[]}}}' } }] }, finish_reason: null }] }) + '\n\n');
      } else if (closing) response.write('data: ' + JSON.stringify(chunk('Closing.')) + '\n\n');
      response.end('data: ' + JSON.stringify({ ...chunk('', true), choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    });
    await expect(runLibreChat({ ...input(endpoint), mode: 'chat', tools: true }, new AbortController().signal, text => { output += text; }, async () => '{"presented":true}')).resolves.toBeUndefined();
    expect(output).toBe('The substantive feasibility analysis.' + (closing ? 'Closing.' : ''));
  }, 30000);
  it.each([undefined, 'fixture-folder'])('advertises local file tools with or without a selected Project folder (%s)', async projectRoot => {
    let names: string[] = [];
    const endpoint = await fixture(async (request, response) => {
      let raw = ''; for await (const part of request) raw += part;
      names = JSON.parse(raw).tools.map((tool: any) => tool.function.name);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end('data: ' + JSON.stringify(chunk('Folder-aware reply.')) + '\n\ndata: ' + JSON.stringify(chunk('', true)) + '\n\ndata: [DONE]\n\n');
    });
    await runLibreChat({ ...input(endpoint), projectRoot, tools: true, contextWindowTokens: 64000 }, new AbortController().signal, () => {}, async () => '{}');
    for (const name of ['write_project_file', 'read_project_file', 'list_project_files']) expect(names.includes(name)).toBe(true);
    expect(names).toEqual(expect.arrayContaining(['present', 'search_sources', 'load_tools']));
    expect(names).not.toContain('browser_open'); expect(names).not.toContain('generate_image');
  }, 30000);
  it('injects steering after an in-flight tool settles without replaying that tool', async () => {
    const consumed: string[] = []; const inbox = new SteeringInbox(ids => consumed.push(...ids));
    const id = randomUUID(); let calls = 0; let tools = 0; let answer = ''; let toolSettled = false;
    const endpoint = await fixture(async (request, response) => {
      let raw = ''; for await (const part of request) raw += part; const body = JSON.parse(raw);
      const n = ++calls;
      if (n === 2) {
        expect(toolSettled).toBe(true);
        expect(body.messages.some((message: any) => message.role === 'tool' && message.content.includes('Saved evidence'))).toBe(true);
        expect(body.messages.at(-1)).toMatchObject({ role: 'user', content: 'Focus on the saved evidence.' });
      }
      const delta = n === 1 ? { role: 'assistant', tool_calls: [{ index: 0, id: 'search_once', type: 'function', function: { name: 'search_sources', arguments: '{"query":"evidence"}' } }] } : { role: 'assistant', content: 'Using the saved evidence.' };
      response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(`data: ${JSON.stringify({ ...chunk(''), choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...chunk('', true), choices: [{ index: 0, delta: {}, finish_reason: n === 1 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
    await runLibreChat({ ...input(endpoint), tools: true, contextWindowTokens: 64000 }, new AbortController().signal, text => { answer += text; }, async () => {
      tools++;
      inbox.add([{ id, text: 'Focus on the saved evidence.', attachmentIds: [], createdAt: Date.now(), lane: 'steer' }]);
      expect(consumed).toEqual([]);
      await new Promise(resolve => setTimeout(resolve, 40)); toolSettled = true;
      return '{"passages":[{"text":"Saved evidence"}]}';
    }, undefined, undefined, undefined, undefined, undefined, inbox);
    expect(tools).toBe(1); expect(calls).toBe(2); expect(consumed).toEqual([id]); expect(answer).toBe('Using the saved evidence.');
  }, 30000);
  it.each([false, true])('lets json-render repair the indicated prop through the provider harness (extra=%s)', async encoded => {
    const history = new HistoryStore(':memory:');
    try {
      const conversation = history.createConversation(null); const turn = history.startTurn(conversation.id, 'Show a list', 'local');
      const broker = new ToolBroker(history, () => defaultSettings, {} as BrowserController, {} as ProjectFiles, () => {});
      const context = { conversationId: conversation.id, runId: turn.runId, signal: new AbortController().signal };
      const valid = { root: 'list', elements: { list: { type: 'Checklist', props: { title: 'Plan', items: [{ text: 'Example' }] }, children: [] } } };
      let calls = 0; let answer = '';
      const endpoint = await fixture(async (request, response) => {
        let raw = ''; for await (const part of request) raw += part; const body = JSON.parse(raw);
        const n = ++calls;
        if (n === 1) expect(body.tools.find((tool: any) => tool.function.name === 'present').function.parameters.properties.root.description).toContain('ID of the root element');
        if (n === 2) expect(body.messages.filter((message: any) => message.role === 'tool').at(-1).content).toContain('elements.list.props (Checklist)');
        if (n === 3) expect(body.messages.filter((message: any) => message.role === 'tool').at(-1).content).toContain('"presented":true');
        const args = n === 1 ? { root: 'list', elements: { list: { type: 'Checklist', props: { title: 'Plan', items: [encoded ? { label: 'Example' } : { text: 42 }] }, children: [] } } } : valid;
        const delta = n <= 2 ? { role: 'assistant', tool_calls: [{ index: 0, id: `present_${n}`, type: 'function', function: { name: 'present', arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: 'Here is the list.' };
        response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(`data: ${JSON.stringify({ ...chunk(''), id: `present-step-${n}`, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...chunk('', true), id: `present-step-${n}`, choices: [{ index: 0, delta: {}, finish_reason: n <= 2 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
      });
      await runLibreChat({ ...input(endpoint), tools: true, contextWindowTokens: 64000 }, context.signal, text => { answer += text; }, request => broker.execute(context, request));
      expect(calls).toBe(3); expect(answer).toBe('Here is the list.');
      expect(JSON.parse(history.conversation(conversation.id).tools[0].result!).ui).toEqual(valid);
    } finally { history.close(); }
  }, 30000);
  it('completes productive tool work beyond the old tool and graph-step limits', async () => {
    let calls = 0; let tools = 0; let answer = '';
    const endpoint = await fixture(async (request, response) => {
      for await (const _part of request) { /* consume */ }
      const n = ++calls; response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const delta = n <= 25 ? { role: 'assistant', tool_calls: [{ index: 0, id: `call_${n}`, type: 'function', function: { name: 'search_sources', arguments: JSON.stringify({ query: `Evidence ${n}` }) } }] } : { role: 'assistant', content: 'Completed all 25 searches.' };
      response.end(`data: ${JSON.stringify({ ...chunk(''), id: `long-${n}`, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...chunk('', true), id: `long-${n}`, choices: [{ index: 0, delta: {}, finish_reason: n <= 25 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
    await runLibreChat({ ...input(endpoint), tools: true, contextWindowTokens: 64000 }, new AbortController().signal, text => { answer += text; }, async () => { tools++; return JSON.stringify({ passages: [] }); });
    expect(tools).toBe(25); expect(calls).toBe(26); expect(answer).toBe('Completed all 25 searches.');
  }, 30000);
  it('pauses unchanged failed tool loops before executing another identical attempt', async () => {
    let calls = 0; let executions = 0;
    const endpoint = await fixture(async (request, response) => {
      for await (const _part of request) { /* consume */ }
      const n = ++calls; response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ ...chunk(''), id: `loop-${n}`, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `failed_${n}`, type: 'function', function: { name: 'read_project_file', arguments: '{"path":"missing.md"}' } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...chunk('', true), id: `loop-${n}`, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
    });
    await expect(runLibreChat({ ...input(endpoint), tools: true, projectRoot: 'fixture-folder' }, new AbortController().signal, () => {}, async () => { executions++; return '{"error":"The file is unavailable."}'; })).rejects.toThrow('same action kept failing');
    expect(calls).toBe(4); expect(executions).toBe(3);
  }, 30000);
  it('generates small metadata JSON without tools, checkpoint rewriting, or recursive summaries', async () => {
    let body: any; let answer = ''; let calls = 0;
    const description = JSON.stringify({ title: 'TinyGPT UI and Bot customization', summary: 'Improving navigation and the Bot designer.', topicChanged: false });
    const endpoint = await fixture(async (request, response) => {
      calls++; let raw = ''; for await (const part of request) raw += part; body = JSON.parse(raw);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(`data: ${JSON.stringify(chunk(description))}\n\ndata: ${JSON.stringify(chunk('', true))}\n\ndata: [DONE]\n\n`);
    });
    await runLibreChat({ ...input(endpoint), purpose: 'metadata', tools: false, maxOutputTokens: 512, instructions: 'Return the sidebar description as JSON only.' }, new AbortController().signal, text => { answer += text; });
    expect(answer).toBe(description); expect(calls).toBe(1); expect(body.max_tokens).toBe(512);
    expect(body.tools?.length ?? 0).toBe(0); expect(JSON.stringify(body.messages)).toContain('Return the sidebar description as JSON only.');
    expect(JSON.stringify(body.messages)).not.toContain('conversation checkpoint');
  }, 30000);
  it('keeps ordinary tool-enabled chat viable in the default small local window', async () => {
    let body: any; let answer = '';
    const endpoint = await fixture(async (request, response) => {
      let raw = ''; for await (const part of request) raw += part; body = JSON.parse(raw);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(`data: ${JSON.stringify(chunk('Small model reply.'))}\n\ndata: ${JSON.stringify(chunk('', true))}\n\ndata: [DONE]\n\n`);
    });
    await runLibreChat({ ...input(endpoint), route: 'local', tools: true, instructions: 'Answer clearly and use the declared tools when needed. '.repeat(30) }, new AbortController().signal, text => { answer += text; }, async () => '{}');
    expect(answer).toBe('Small model reply.');
    expect(body.tools.some((tool: any) => tool.function.name === 'search_sources')).toBe(true);
    expect(body.tools.map((tool: any) => tool.function.name)).toEqual(expect.arrayContaining(['load_tools', 'present', 'calculate']));
    expect(body.tools.some((tool: any) => tool.function.name === 'browser_open')).toBe(false);
    const ui = body.tools.find((tool: any) => tool.function.name === 'present');
    if (ui) expect(JSON.stringify(ui.function.parameters.properties.elements)).toContain('ChartPanel');
  });
  it('streams OpenRouter thinking and announces action preparation before executing a complete tool', async () => {
    const order: string[] = []; let calls = 0;
    const endpoint = await fixture(async (request, response) => {
      for await (const _part of request) { /* consume */ }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const delta = (value: unknown) => `data: ${JSON.stringify({ ...chunk(''), choices: [{ index: 0, delta: value, finish_reason: null }] })}\n\n`;
      if (++calls === 1) {
        response.write(delta({ role: 'assistant', reasoning: 'Checking what to write.' }));
        response.write(delta({ tool_calls: [{ index: 0, id: 'call_write', type: 'function', function: { name: 'write_project_file', arguments: '{"path":"brief.md","content":"' } }] }));
        await new Promise(resolve => setTimeout(resolve, 25));
        response.end(delta({ tool_calls: [{ index: 0, function: { arguments: 'Complete"}' } }] }) + `data: ${JSON.stringify({ ...chunk('', true), choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
      } else response.end(`data: ${JSON.stringify(chunk('Saved.'))}\n\ndata: ${JSON.stringify(chunk('', true))}\n\ndata: [DONE]\n\n`);
    });
    await runLibreChat({ ...input(endpoint), provider: 'openrouter', tools: true, projectRoot: 'fixture-folder' }, new AbortController().signal, () => {}, async request => { order.push('execute'); expect(request.input).toEqual({ path: 'brief.md', content: 'Complete' }); return '{}'; }, text => { if (text.includes('Checking')) order.push('thinking'); }, event => { if (event.type === 'preparing-tool') order.push('preparing'); });
    expect(order).toContain('thinking'); expect(order.indexOf('preparing')).toBeLessThan(order.indexOf('execute')); expect(order.filter(event => event === 'execute')).toHaveLength(1);
  }, 30000);
  it('reports transport progress before checkpoint validation releases its buffered answer', async () => {
    const order: string[] = [];
    const endpoint = await fixture(async (request, response) => {
      for await (const _part of request) { /* consume */ }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': provider keepalive\n\n');
      await new Promise(resolve => setTimeout(resolve, 20));
      response.end(`data: ${JSON.stringify(chunk('A complete checkpoint.'))}\n\ndata: ${JSON.stringify(chunk('', true))}\n\ndata: [DONE]\n\n`);
    });
    await runLibreChat({ ...input(endpoint), purpose: 'summary' }, new AbortController().signal, text => { order.push(`text:${text}`); }, undefined, undefined, undefined, undefined, activity => order.push(activity));
    expect(order[0]).toBe('request'); expect(order.indexOf('data')).toBeLessThan(order.findIndex(item => item.startsWith('text:'))); expect(order.join(' ')).toContain('A complete checkpoint.');
  }, 30000);
  it.each([false, true])('recognizes output truncation and never executes cut-off tools (tool=%s)', async tool => {
    const bodies: any[] = []; let toolCalls = 0; let answer = '';
    const endpoint = await fixture(async (request, response) => {
      let raw = ''; for await (const part of request) raw += part;
      bodies.push(JSON.parse(raw));
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_cutoff', type: 'function', function: { name: 'write_project_file', arguments: '{"path":"large.md","content":"unfinished' } }] } : { role: 'assistant', content: 'Saved partial answer' };
      response.end(`data: ${JSON.stringify({ ...chunk(''), choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...chunk('', true), choices: [{ index: 0, delta: {}, finish_reason: 'length' }] })}\n\ndata: [DONE]\n\n`);
    });
    await expect(runLibreChat({ ...input(endpoint), tools: tool, projectRoot: 'fixture-folder', maxOutputTokens: 12000 }, new AbortController().signal, text => { answer += text; }, async () => { toolCalls++; return '{}'; })).rejects.toThrow(tool ? TOOL_OUTPUT_LIMIT_MESSAGE : OUTPUT_LIMIT_MESSAGE);
    expect(answer).toBe(tool ? '' : 'Saved partial answer'); expect(toolCalls).toBe(0); expect(bodies).toHaveLength(1);
    expect(bodies[0].max_tokens ?? bodies[0].max_completion_tokens).toBe(12000);
  }, 30000);
  it('rejects truncated checkpoints instead of persisting partial conversation memory', async () => {
    let requests = 0; let leaked = '';
    const endpoint = await fixture(async (request, response) => {
      requests++;
      for await (const _part of request) { /* consume */ }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify(chunk('Incomplete checkpoint'))}\n\ndata: ${JSON.stringify({ ...chunk('', true), choices: [{ index: 0, delta: {}, finish_reason: 'length' }] })}\n\ndata: [DONE]\n\n`);
    });
    await expect(runLibreChat({ ...input(endpoint), purpose: 'summary' }, new AbortController().signal, text => { leaked += text; })).rejects.toThrow(COMPACTION_OUTPUT_LIMIT_MESSAGE);
    expect(requests).toBe(2); expect(leaked).toBe('');
  }, 30000);
  it('recovers a truncated checkpoint with a larger budget and commits only the complete replacement', async () => {
    const requests: any[] = [];
    const endpoint = await fixture(async (request, response) => {
      let raw = ''; for await (const part of request) raw += part;
      const body = JSON.parse(raw); requests.push(body);
      const summarizing = JSON.stringify(body.messages).includes('Write a concise conversation checkpoint');
      const truncated = summarizing && requests.filter(body => JSON.stringify(body.messages).includes('Write a concise conversation checkpoint')).length === 1;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const text = truncated ? 'NEVER COMMIT THIS PARTIAL CHECKPOINT' : summarizing ? 'Goal: BLUEBIRD. Preserve recorded outcomes.' : 'BLUEBIRD preserved.';
      response.end(`data: ${JSON.stringify(chunk(text))}\n\ndata: ${JSON.stringify({ ...chunk('', true), choices: [{ index: 0, delta: {}, finish_reason: truncated ? 'length' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
    const events: import('../src/shared/chat').ContextEvent[] = []; let answer = '';
    await runLibreChat({ ...input(endpoint), messages: [{ id: randomUUID(), role: 'user', text: 'Remember BLUEBIRD' }, { id: randomUUID(), role: 'assistant', text: 'Old evidence and decisions. '.repeat(6000) }, { id: randomUUID(), role: 'user', text: 'What is the goal?' }] }, new AbortController().signal, text => { answer += text; }, undefined, undefined, undefined, event => events.push(event));
    const summaries = requests.filter(body => JSON.stringify(body.messages).includes('Write a concise conversation checkpoint'));
    expect(summaries[0].max_tokens).toBe(8192); expect(summaries[1].max_tokens).toBeGreaterThan(8192);
    expect(JSON.stringify(summaries[0].messages)).toContain('at most 1500 visible text tokens');
    expect(events.filter(event => event.type === 'checkpoint').length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain('NEVER COMMIT'); expect(answer).toBe('BLUEBIRD preserved.');
  }, 30000);
  it.each([false, true])('handles tool-loop context pressure without leaking summaries or accepting failed checkpoints (failure=%s)', async failSummary => {
    let step = 0; let summaryCalls = 0;
    const endpoint = await fixture(async (request, response) => {
      let raw = ''; for await (const part of request) raw += part;
      const body = JSON.parse(raw);
      const summarizing = JSON.stringify(body.messages).includes('Write a concise conversation checkpoint');
      if (summarizing) {
        summaryCalls++;
        if (failSummary) { response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'private-compaction-failure', type: 'api_error' } })); return; }
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify(chunk('Goal: BLUEBIRD. Recorded tool evidence reviewed. Continue without repeating actions.'))}\n\ndata: ${JSON.stringify(chunk('', true))}\n\ndata: [DONE]\n\n`);
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const index = step++;
      const tool = index < 6;
      const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `call_pressure_${index}`, type: 'function', function: { name: 'search_sources', arguments: '{"query":"BLUEBIRD"}' } }] } : { role: 'assistant', content: 'Final BLUEBIRD answer.' };
      response.end(`data: ${JSON.stringify({ ...chunk(''), id: `chatcmpl-pressure-${index}`, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...chunk('', true), id: `chatcmpl-pressure-${index}`, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
    const events: import('../src/shared/chat').ContextEvent[] = []; let answer = '';
    const run = runLibreChat({ ...input(endpoint), messages: [{ id: randomUUID(), role: 'user', text: 'Review BLUEBIRD evidence' }], contextWindowTokens: 24576, tools: true }, new AbortController().signal, delta => { answer += delta; }, async () => 'Evidence: '+Array.from({length:900},(_,i)=>((i*15473)%65536).toString(16).padStart(4,'0')).join(' '), undefined, undefined, event => events.push(event));
    if (failSummary) {
      await expect(run).rejects.toThrow('Conversation optimization could not finish');
      expect(answer).toBe('');
      expect(events.some(event => event.type === 'checkpoint')).toBe(false);
      expect(events.some(event => event.type === 'optimization-failed')).toBe(true);
    } else {
      await run;
      expect(answer).toBe('Final BLUEBIRD answer.');
      expect(events.some(event => event.type === 'optimized')).toBe(true);
      expect(events.some(event => event.type === 'checkpoint')).toBe(false);
    }
    expect(summaryCalls).toBeGreaterThan(0);
  }, 60000);
  it('automatically checkpoints oversized history and sends a small subsequent prompt', async () => {
    const bodies: any[] = [];
    const endpoint = await fixture(async (request, response) => {
      let raw = ''; for await (const part of request) raw += part;
      const body = JSON.parse(raw); bodies.push(body);
      const summarizing = JSON.stringify(body.messages).includes('Write a concise conversation checkpoint');
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify(chunk(summarizing ? 'Goal: BLUEBIRD. Preserve the requested format. Evidence reviewed.' : 'BLUEBIRD carried forward.'))}\n\ndata: ${JSON.stringify(chunk('', true))}\n\ndata: [DONE]\n\n`);
    });
    const messages = [{ id: randomUUID(), role: 'user' as const, text: 'Remember BLUEBIRD' }, { id: randomUUID(), role: 'assistant' as const, text: 'Prior detail with requirements and preferences. '.repeat(6000) }, { id: randomUUID(), role: 'user' as const, text: 'What was the goal?' }];
    const events: import('../src/shared/chat').ContextEvent[] = []; let answer = '';
    await runLibreChat({ ...input(endpoint), messages }, new AbortController().signal, delta => { answer += delta; }, undefined, undefined, undefined, event => events.push(event));
    expect(answer).toBe('BLUEBIRD carried forward.');
    expect(events.some(event => event.type === 'optimizing')).toBe(true);
    const checkpoint = events.filter(event => event.type === 'checkpoint').at(-1)!;
    expect(checkpoint.checkpoint.throughMessageId).toBe(messages[1].id);
    const final = bodies.at(-1); expect(JSON.stringify(final.messages).length).toBeLessThan(3000);
    expect(JSON.stringify(final.messages)).toContain('BLUEBIRD'); expect(final.tools).toBeUndefined();
    const summaryCalls = bodies.length - 1; expect(summaryCalls).toBeGreaterThan(0);
    const { createTokenCounter } = await import('@librechat/agents'); const { HumanMessage } = await import('@librechat/agents/langchain/messages');
    const counter = await createTokenCounter();
    expect(bodies.every(body => counter(new HumanMessage(JSON.stringify(body.messages))) < 17000)).toBe(true);
    await runLibreChat({ ...input(endpoint), checkpoint: checkpoint.checkpoint, messages: [messages[2], { id: randomUUID(), role: 'assistant', text: answer }, { id: randomUUID(), role: 'user', text: 'Continue' }] }, new AbortController().signal, () => {});
    expect(bodies.length).toBe(summaryCalls + 2); expect(JSON.stringify(bodies.at(-1).messages).length).toBeLessThan(3000);
  }, 60000);
  it('announces separate prose/tool/final segments across model and tool rounds', async () => {
    let step = 0;
    const endpoint = await fixture(async (request, response) => {
      for await (const _part of request) { /* consume */ }
      const index = step++;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const text = index === 0 ? 'First progress update.' : index === 1 ? 'Second progress update.' : 'Only the final answer.';
      const toolDelta = { ...chunk(''), choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_prose_${index}`, type: 'function', function: { name: 'search_sources', arguments: '{"query":"fixture"}' } }] }, finish_reason: null }] };
      const end = { ...chunk('', true), choices: [{ index: 0, delta: {}, finish_reason: index < 2 ? 'tool_calls' : 'stop' }] };
      const frame = (value: Record<string, unknown>) => JSON.stringify({ ...value, id: `chatcmpl-prose-${index}` });
      response.end(`data: ${frame(chunk(text))}\n\n${index < 2 ? `data: ${frame(toolDelta)}\n\n` : ''}data: ${frame(end)}\n\ndata: [DONE]\n\n`);
    });
    let answer = ''; let prose = ''; const events: ResponseEvent[] = [];
    await runLibreChat({ ...input(endpoint), tools: true }, new AbortController().signal, delta => { answer += delta; }, async () => '{}', undefined, event => {
      events.push(event);
      if (event.type === 'tool') { prose = answer; answer = ''; }
      else if (event.type === 'start') { answer = ''; prose = ''; }
    });
    expect(events).toEqual([{ type: 'start', lane: 'answer' }, { type: 'end' }, { type: 'tool' }, { type: 'start', lane: 'answer' }, { type: 'end' }, { type: 'tool' }, { type: 'start', lane: 'answer' }, { type: 'end' }]);
    expect(answer).toBe('Only the final answer.'); expect(prose).toBe('');
  }, 30000);
  it('forwards actual reasoning deltas separately from answer text', async () => {
    const endpoint = await fixture(async (request, response) => {
      for await (const _part of request) { /* consume */ }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const thought = { ...chunk(''), choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'A provider thinking summary.' }, finish_reason: null }] };
      response.end(`data: ${JSON.stringify(thought)}\n\ndata: ${JSON.stringify(chunk('The final answer.'))}\n\ndata: ${JSON.stringify(chunk('', true))}\n\ndata: [DONE]\n\n`);
    });
    const text: string[] = []; const reasoning: string[] = [];
    await runLibreChat(input(endpoint), new AbortController().signal, delta => text.push(delta), undefined, delta => reasoning.push(delta));
    expect(text.join('')).toBe('The final answer.');
    expect(reasoning.join('')).toBe('A provider thinking summary.');
  }, 30000);
  it('validates browser target arguments with the harness structured-tool implementation', async () => {
    const { DynamicStructuredTool } = await import('@librechat/agents/langchain/tools');
    const definition = toolDefinitions.find(tool => tool.name === 'browser_type')!;
    const args = { tabId: randomUUID(), elementId: 't0', text: 'BLUEBIRD note' };
    const tool = new DynamicStructuredTool({ name: definition.name, description: definition.description, schema: definition.schema, verboseParsingErrors: true, func: async input => JSON.stringify(input) });
    expect(await tool.invoke(args)).toBe(JSON.stringify(args));
  });
  it('runs consecutive page-read, type and click tool calls through the real graph', async () => {
    let step = 0; const tabId = randomUUID(); const names: string[] = [];
    const endpoint = await fixture(async (request, response) => {
      for await (const _part of request) { /* consume */ }
      const actions = [
        ['read_page', { url: 'https://example.com' }],
        ['load_tools', { group: 'browser' }],
        ['browser_type', { tabId, elementId: 't0', text: 'BLUEBIRD note' }],
        ['browser_click', { tabId, elementId: 't1' }],
      ] as const;
      const action = actions[step++]; response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const delta = action ? { role: 'assistant', tool_calls: [{ index: 0, id: `call_step_${step}`, type: 'function', function: { name: action[0], arguments: JSON.stringify(action[1]) } }] } : { role: 'assistant', content: 'Browser task finished.' };
      response.end(`data: ${JSON.stringify({ ...chunk(''), id: `chatcmpl-step-${step}`, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...chunk('', true), id: `chatcmpl-step-${step}`, choices: [{ index: 0, delta: {}, finish_reason: action ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
    const text: string[] = [];
    await runLibreChat({ ...input(endpoint), tools: true }, new AbortController().signal, delta => text.push(delta), async request => { if (request.validationError) throw Error(request.validationError); names.push(request.name); return request.name === 'load_tools' ? '{"enabled":"browser"}' : JSON.stringify({ tabId, text: 'Local form', elements: [{ id: 't0', label: 'Work note', role: 'input' }, { id: 't1', label: 'Save note', role: 'button' }] }); });
    expect(names).toEqual(['read_page', 'load_tools', 'browser_type', 'browser_click']); expect(text.join('')).toBe('Browser task finished.');
  }, 30000);
  it('executes a real tool call through the host callback and feeds its result into the next model step', async () => {
    const requests: any[] = [];
    const endpoint = await fixture(async (request, response) => {
      let raw = ''; for await (const part of request) raw += part; const body = JSON.parse(raw); requests.push(body);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (requests.length === 1) {
        const toolChunk = { ...chunk(''), choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name: 'search_sources', arguments: '{"status":"Reviewing the Bluebird brief","permission":"May I search your saved sources for Bluebird?","query":"BLUEBIRD"}' } }] }, finish_reason: null }] };
        const finish = { ...chunk('', true), choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] };
        response.end(`data: ${JSON.stringify(toolChunk)}\n\ndata: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`);
      } else response.end(`data: ${JSON.stringify(chunk('The cited result is BLUEBIRD.'))}\n\ndata: ${JSON.stringify(chunk('', true))}\n\ndata: [DONE]\n\n`);
    });
    const config = { ...input(endpoint), tools: true, effort: 'instant' as const, reasoning: { kind: 'ollama' as const, efforts: ['low', 'medium', 'high'] as const, canDisable: true } }; const called: unknown[] = []; const deltas: string[] = [];
    const controller = { ...config, reasoning: { ...config.reasoning, efforts: [...config.reasoning.efforts] } };
    await runLibreChat(controller, new AbortController().signal, text => deltas.push(text), async request => { called.push(request); return JSON.stringify({ passages: [{ text: 'BLUEBIRD', citation: '[Fixture](tinygpt-source:00000000-0000-4000-8000-000000000001)' }] }); });
    expect(called).toEqual([expect.objectContaining({ name: 'search_sources', displayText: 'Reviewing the Bluebird brief', approvalText: 'May I search your saved sources for Bluebird?', input: { query: 'BLUEBIRD' } })]);
    expect(requests).toHaveLength(2); expect(requests[0].tools.some((tool: any) => tool.function.name === 'search_sources')).toBe(true);
    expect(requests.every(body => body.reasoning_effort === 'none')).toBe(true);
    expect(requests[1].messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_fixture', content: expect.stringContaining('BLUEBIRD') });
    expect(deltas.join('')).toBe('The cited result is BLUEBIRD.');
  }, 30000);
  it('streams a real Chat Completions request to a local endpoint with instructions and history', async () => {
    let body: any; let authorization: string | undefined; let ended = false;
    const endpoint = await fixture(async (request, response) => {
      expect(request.url).toBe('/v1/chat/completions'); authorization = request.headers.authorization;
      let raw = ''; for await (const part of request) raw += part; body = JSON.parse(raw);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify(chunk('Hello '))}\n\n`);
      setTimeout(() => { ended = true; response.end(`data: ${JSON.stringify(chunk('world.'))}\n\ndata: ${JSON.stringify(chunk('', true))}\n\ndata: [DONE]\n\n`); }, 200);
    });
    const deltas: string[] = []; let firstBeforeEnd = false;
    const config = input(endpoint); config.messages.push({ role: 'assistant', text: 'Earlier answer' }, { role: 'user', text: 'Continue' });
    await runLibreChat(config, new AbortController().signal, text => { if (!deltas.length) firstBeforeEnd = !ended; deltas.push(text); });
    expect(deltas.join('')).toBe('Hello world.'); expect(firstBeforeEnd).toBe(true);
    expect(authorization).toBe('Bearer fixture-key'); expect(body.stream).toBe(true);
    expect(body.messages[0].content).toMatch(/^Answer in short sentences\.\n\n<tinygpt-runtime-context>/);
    expect(body.messages.slice(1).map((message: any) => message.content)).toEqual(['Hello fixture', 'Earlier answer', 'Continue']);
  }, 30000);
  it.each([false, true])('uses Anthropic Messages and output limits with the selected endpoint and key (truncated=%s)', async truncated => {
    let body: any; let key: string | string[] | undefined;
    const endpoint = await fixture(async (request, response) => {
      expect(request.url).toBe('/v1/messages'); key = request.headers['x-api-key'];
      let raw = ''; for await (const part of request) raw += part; body = JSON.parse(raw);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const events = [
        ['message_start', { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', content: [], model: 'fixture-model', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Anthropic fixture reply.' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: truncated ? 'max_tokens' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
        ['message_stop', { type: 'message_stop' }],
      ];
      response.end(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
    });
    const deltas: string[] = [];
    const run = runLibreChat({ ...input(endpoint, 'anthropic'), effort: 'instant', reasoning: { kind: 'anthropic-budget', efforts: [], canDisable: true, tokenBudget: true } }, new AbortController().signal, text => deltas.push(text));
    if (truncated) await expect(run).rejects.toThrow(OUTPUT_LIMIT_MESSAGE); else await run;
    expect(deltas.join('')).toBe('Anthropic fixture reply.'); expect(key).toBe('fixture-key');
    expect(body.system).toMatch(/^Answer in short sentences\.\n\n<tinygpt-runtime-context>/);
    expect(body.messages[0].content).toBe('Hello fixture');
    expect(body.thinking).toEqual({ type: 'disabled' });
  }, 30000);
  it.each([false, true])('streams OpenAI Responses and output limits using the selected endpoint (truncated=%s)', async truncated => {
    let body: any;
    const endpoint = await fixture(async (request, response) => {
      expect(request.url).toBe('/v1/responses');
      let raw = ''; for await (const part of request) raw += part; body = JSON.parse(raw);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const item = { id: 'msg_fixture', type: 'message', role: 'assistant', phase: 'final_answer', status: 'in_progress', content: [] };
      const narration = { ...item, id: 'msg_narration', phase: 'commentary' };
      const base = { id: 'resp_fixture', object: 'response', created_at: 1, model: 'fixture-model', status: 'in_progress', output: [], error: null, incomplete_details: null };
      const events = [
        { type: 'response.created', response: base },
        { type: 'response.output_item.added', output_index: 0, item: narration },
        { type: 'response.content_part.added', item_id: narration.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
        { type: 'response.output_text.delta', item_id: narration.id, output_index: 0, content_index: 0, delta: 'Provider commentary.' },
        { type: 'response.output_text.done', item_id: narration.id, output_index: 0, content_index: 0, text: 'Provider commentary.' },
        { type: 'response.content_part.done', item_id: narration.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: 'Provider commentary.', annotations: [] } },
        { type: 'response.output_item.done', output_index: 0, item: { ...narration, status: 'completed', content: [{ type: 'output_text', text: 'Provider commentary.', annotations: [] }] } },
        { type: 'response.output_item.added', output_index: 1, item },
        { type: 'response.content_part.added', item_id: item.id, output_index: 1, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
        { type: 'response.output_text.delta', item_id: item.id, output_index: 1, content_index: 0, delta: 'Responses fixture reply.' },
        { type: 'response.output_text.done', item_id: item.id, output_index: 1, content_index: 0, text: 'Responses fixture reply.' },
        { type: 'response.content_part.done', item_id: item.id, output_index: 1, content_index: 0, part: { type: 'output_text', text: 'Responses fixture reply.', annotations: [] } },
        { type: 'response.output_item.done', output_index: 1, item: { ...item, status: 'completed', content: [{ type: 'output_text', text: 'Responses fixture reply.', annotations: [] }] } },
        { type: truncated ? 'response.incomplete' : 'response.completed', response: { ...base, status: truncated ? 'incomplete' : 'completed', incomplete_details: truncated ? { reason: 'max_output_tokens' } : null, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, output: [{ ...narration, status: 'completed', content: [{ type: 'output_text', text: 'Provider commentary.', annotations: [] }] }, { ...item, status: truncated ? 'incomplete' : 'completed', content: [{ type: 'output_text', text: 'Responses fixture reply.', annotations: [] }] }] } },
      ];
      response.end(events.map((event, index) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`).join(''));
    });
    let finalText = ''; const lanes: string[] = [];
    const run = runLibreChat({ ...input(endpoint, 'openai-responses'), effort: 'max', reasoning: { kind: 'openai', efforts: ['low', 'medium', 'high'], canDisable: false } }, new AbortController().signal, text => { finalText += text; }, undefined, undefined, event => { if (event.type === 'start') { finalText = ''; lanes.push(event.lane); } });
    if (truncated) await expect(run).rejects.toThrow(OUTPUT_LIMIT_MESSAGE); else await run;
    expect(finalText).toBe('Responses fixture reply.'); expect(lanes).toEqual(['progress', 'answer']); expect(body.stream).toBe(true);
    expect(JSON.stringify(body)).toContain('Answer in short sentences.'); expect(JSON.stringify(body)).toContain('Hello fixture');
    expect(body.reasoning).toMatchObject({ effort: 'high' });
  }, 30000);
  it.each([401, 429, 500])('sanitizes provider errors (%i), without echoing upstream bodies or secrets', async status => {
    const endpoint = await fixture((_request, response) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'secret-fixture-key-private-response', type: 'api_error' } })));
    await expect(runLibreChat(input(endpoint), new AbortController().signal, () => {})).rejects.toThrow(status === 401 ? 'did not accept the API key' : status === 429 ? 'usage limit' : 'temporarily unavailable');
  }, 30000);
  it('reports an insufficient native thinking budget without making an upstream request', async () => {
    let calls = 0;
    const endpoint = await fixture((_request, response) => { calls++; response.writeHead(500).end(); });
    const config = { ...input(endpoint, 'anthropic'), maxOutputTokens: 128, effort: 'high' as const, reasoning: { kind: 'anthropic-budget' as const, efforts: [], canDisable: true, tokenBudget: true } };
    await expect(runLibreChat(config, new AbortController().signal, () => {})).rejects.toThrow('Increase Maximum output tokens in Configuration');
    expect(calls).toBe(0);
  }, 30000);
  it('aborts a streaming provider request', async () => {
    let closed = false;
    const endpoint = await fixture(async (request, response) => {
      for await (const _part of request) { /* consume request */ }
      response.on('close', () => { closed = true; });
      response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(`data: ${JSON.stringify(chunk('Partial'))}\n\n`);
    });
    const controller = new AbortController();
    await expect(runLibreChat(input(endpoint), controller.signal, () => controller.abort())).rejects.toThrow();
    await new Promise(resolve => setTimeout(resolve, 50)); expect(closed).toBe(true);
  }, 30000);
});
describe('provider credential boundaries', () => {
  it('blocks another origin and endpoint path before dispatch', async () => {
    let calls = 0;
    const wrapped = scopedFetch('https://provider.example/v1', async () => { calls++; return new Response('{}'); });
    await expect(wrapped('https://other.example/v1/chat/completions')).rejects.toThrow('outside');
    await expect(wrapped('https://provider.example/v10/chat/completions')).rejects.toThrow('outside');
    await wrapped('https://provider.example/v1/chat/completions'); expect(calls).toBe(1);
  });
  it('refuses redirects that could forward a provider key', async () => {
    let redirect: RequestRedirect | undefined;
    await scopedFetch('https://provider.example/v1', async (_url, options) => { redirect = options?.redirect; return new Response('{}'); })('https://provider.example/v1/responses');
    expect(redirect).toBe('error');
  });
});


it('keeps plugin schemas out of Chat until the loader selects them, then replaces the loaded set', async () => {
  const a = 'ext_read_page_aaaaaaaaaaaaaaaaaaaaaaaa', b = 'ext_read_mail_bbbbbbbbbbbbbbbbbbbbbbbb';
  let calls = 0; const executed: string[] = [];
  const endpoint = await fixture(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    const body = JSON.parse(raw), names = body.tools.map((tool: any) => tool.function.name); calls++;
    expect(names).toContain('load_tools'); expect(names).not.toContain('request_plugin_connection');
    if (calls === 1) { expect(names).not.toContain(a); expect(names).not.toContain(b); expect(raw).not.toContain('UNUSED_PRIVATE_SCHEMA'); expect(raw).not.toContain('DORMANT_PLUGIN_SCHEMA'); expect(raw).not.toContain('ext_unused_0'); }
    else if (calls <= 3) { expect(names).toContain(a); expect(names).not.toContain(b); }
    else { expect(names).not.toContain(a); expect(names).toContain(b); }
    const actions = [
      ['load_tools', { group: 'services', query: 'Notion search' }],
      [a, { query: 'selected-a' }],
      ['load_tools', { group: 'services', query: 'Gmail read' }],
      [b, { query: 'selected-b' }],
    ] as const;
    const action = actions[calls - 1];
    const delta = action ? { role: 'assistant', tool_calls: [{ index: 0, id: 'lazy-' + calls, type: 'function', function: { name: action[0], arguments: JSON.stringify(action[1]) } }] } : { role: 'assistant', content: 'Verified lazy loading.' };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end('data: ' + JSON.stringify({ ...chunk(''), id: 'lazy-model-' + calls, choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ ...chunk('', true), id: 'lazy-model-' + calls, choices: [{ index: 0, delta: {}, finish_reason: action ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await runLibreChat({ ...input(endpoint), mode: 'chat', tools: true, contextWindowTokens: 64000, extensionTools: [a, b].map<NonNullable<ChatWorkerInput['extensionTools']>[number]>((name, i) => ({ name: name as `ext_${string}`, originalName: i ? 'read_mail' : 'read_page', pluginId: String(i), label: 'Read', description: 'Read selected content', category: 'read' as const, schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], description: 'UNUSED_PRIVATE_SCHEMA' } })).concat(Array.from({ length: 93 }, (_, i) => ({ name: `ext_unused_${i}_cccccccccccccccccccccccc` as `ext_${string}`, originalName: 'unused', pluginId: 'unused', label: 'Unused', description: 'Unused private tool', category: 'read' as const, schema: { type: 'object', properties: { value: { type: 'string', description: 'DORMANT_PLUGIN_SCHEMA ' + 'schema tokens '.repeat(250) } } } }))) }, new AbortController().signal, () => {}, async request => {
    if (request.validationError) return request.validationError;
    if (request.name === 'load_tools') return JSON.stringify({ enabled: 'services', toolNames: [(request.input as any).query.includes('Notion') ? a : b] });
    expect((request.input as any).query).toBe(request.name === a ? 'selected-a' : 'selected-b');
    executed.push(request.name); return '{"text":"Actual selected result"}';
  });
  expect(calls).toBe(5); expect(executed).toEqual([a, b]);
});

describe('local Chat answer boundaries', () => {
  const local = (endpoint: string): ChatWorkerInput => ({ ...input(endpoint), route: 'local', provider: 'local', model: 'tinygpt-included', mode: 'chat', effort: 'max', contextWindowTokens: 65536, maxOutputTokens: 8192, reasoning: { kind: 'llamacpp', efforts: [], canDisable: true } });
  it('does not replay an earlier research update before a later tool-only visual', async () => {
    let calls=0;const answer:string[]=[];
    const endpoint=await fixture(async(request,response)=>{
      for await(const _ of request){}const n=++calls;
      const frame=(delta:unknown,finish_reason:string|null=null)=>'data: '+JSON.stringify({...chunk(''),id:'research-visual-'+n,choices:[{index:0,delta,finish_reason}]})+'\n\n';
      response.writeHead(200,{'Content-Type':'text/event-stream'});
      if(n===1)response.write(frame({role:'assistant',content:'I will read the source.'}));
      if(n<=2)response.write(frame({role:'assistant',tool_calls:[{index:0,id:'step-'+n,type:'function',function:n===1?{name:'search_sources',arguments:'{"query":"plans"}'}:{name:'present',arguments:'{"root":"text","elements":{"text":{"type":"Text","props":{"value":"Comparison"},"children":[]}}}'}}]}));
      else response.write(frame({role:'assistant',content:'Verified final answer.'}));
      response.end(frame({},n<=2?'tool_calls':'stop')+'data: [DONE]\n\n');
    });
    await runLibreChat({...local(endpoint),tools:true},new AbortController().signal,text=>answer.push(text),async request=>request.name==='present'?'{"presented":true}':'{"sources":[]}');
    expect(answer.join('')).toBe('Verified final answer.');expect(calls).toBe(3);
  },30000);
  it.each([false, true])('keeps accepted local prose before its completed presentation (closing=%s)', async closing => {
    let calls = 0; const order: string[] = [];
    const endpoint = await fixture(async (request, response) => {
      for await (const _ of request) {} const n = ++calls;
      const frame = (delta: unknown, finish_reason: string | null = null) => 'data: ' + JSON.stringify({ ...chunk(''), id: `local-present-${n}`, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (n === 1) {
        response.write(frame({ role: 'assistant', content: 'Verified analysis.' }));
        response.write(frame({ tool_calls: [{ index: 0, id: 'local-visual', type: 'function', function: { name: 'present', arguments: '{"root":"text","elements":{"text":{"type":"Text","props":{"value":"Priority list"},"children":[]}}}' } }] }));
      } else if (closing) response.write(frame({ role: 'assistant', content: 'Finished.' }));
      response.end(frame({}, n === 1 ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
    });
    await runLibreChat({ ...local(endpoint), tools: true }, new AbortController().signal, text => order.push(text), async () => { order.push('visual'); return '{"presented":true}'; });
    expect(order).toEqual(['Verified analysis.', 'visual', ...(closing ? ['Finished.'] : [])]);
  }, 30000);
  it('publishes a clean local answer only after its successful terminal event, retaining thinking separately', async () => {
    let finished = false, answer = '', thinking = ''; let payload: any;
    const endpoint = await fixture(async (request, response) => {
      let text = ''; for await (const part of request) text += part; payload = JSON.parse(text);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: ' + JSON.stringify({ ...chunk(''), choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Private fixture thinking.' }, finish_reason: null }] }) + '\n\n');
      response.write('data: ' + JSON.stringify(chunk('Verified priority list.')) + '\n\n');
      await new Promise(done => setTimeout(done, 30)); finished = true;
      response.end('data: ' + JSON.stringify(chunk('', true)) + '\n\ndata: [DONE]\n\n');
    });
    await runLibreChat(local(endpoint), new AbortController().signal, text => { expect(finished).toBe(true); answer += text; }, undefined, text => { thinking += text; });
    expect(answer).toBe('Verified priority list.'); expect(thinking).toContain('Private fixture thinking.'); expect(payload.max_tokens).toBe(8192); expect(payload).not.toHaveProperty('reasoning_budget_tokens');
  }, 30000);
  it('rejects split misplaced thinking markers without publishing the working notes', async () => {
    let answer = '';
    const endpoint = await fixture(async (request, response) => {
      for await (const _ of request) {} response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const text of ['Unfinished self-correction.', '\n</thi', 'nk>\nDo not publish this.']) response.write('data: ' + JSON.stringify(chunk(text)) + '\n\n');
      response.end('data: ' + JSON.stringify(chunk('', true)) + '\n\ndata: [DONE]\n\n');
    });
    await expect(runLibreChat(local(endpoint), new AbortController().signal, text => { answer += text; })).rejects.toThrow(MODEL_ANSWER_BOUNDARY_MESSAGE); expect(answer).toBe('');
  }, 30000);
  it.each([false, true])('keeps unfinished local output out of the answer when truncated (tool=%s)', async tool => {
    let answer = '', executed = 0;
    const endpoint = await fixture(async (request, response) => {
      for await (const _ of request) {} response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: ' + JSON.stringify(chunk('Unfinished working notes.')) + '\n\n');
      if (tool) response.write('data: ' + JSON.stringify({ ...chunk(''), choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'incomplete', type: 'function', function: { name: 'search_sources', arguments: '{"query":' } }] }, finish_reason: null }] }) + '\n\n');
      response.end('data: ' + JSON.stringify({ ...chunk('', true), choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }) + '\n\ndata: [DONE]\n\n');
    });
    await expect(runLibreChat({ ...local(endpoint), tools: tool }, new AbortController().signal, text => { answer += text; }, async () => { executed++; return '{}'; })).rejects.toThrow(tool ? TOOL_OUTPUT_LIMIT_MESSAGE : OUTPUT_LIMIT_MESSAGE);
    expect(answer).toBe(''); expect(executed).toBe(0);
  }, 30000);
});

it('restores exact Gmail evidence after a lossy tool-loop summary and refuses guessed IDs', async () => {
  const pluginId = randomUUID();
  const extensions = ['search_mail', 'read_mail'].map(originalName => ({ name: `ext_${originalName}_${'a'.repeat(24)}` as const, originalName, pluginId, label: originalName === 'search_mail' ? 'Search Gmail' : 'Read Gmail message', description: 'Read-only Gmail fixture.', category: 'read' as const, schema: { type: 'object', properties: originalName === 'search_mail' ? { query: { type: 'string' } } : { messageId: { type: 'string' } } } }));
  let step = 0, summaries = 0; const restored: string[] = []; const actualReads: string[] = []; let answer = '';
  const endpoint = await fixture(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part; const body = JSON.parse(raw);
    const summary = JSON.stringify(body.messages).includes('Write a concise conversation checkpoint');
    if (summary) summaries++;
    else if (summaries) restored.push(body.messages.find((m: any) => m.role === 'system')?.content ?? '');
    const index = summary ? -1 : step++;
    const name = index === 0 ? 'load_tools' : index === 1 ? extensions[0].name : [2, 9, 10].includes(index) ? extensions[1].name : 'search_sources';
    const args = index === 0 ? { group: 'services', query: 'Gmail' } : index === 1 ? { query: 'in:inbox' } : index === 2 ? { messageId: 'exact-read-id' } : index === 9 ? { messageId: 'guessed-from-summary' } : index === 10 ? { messageId: 'exact-missing-id' } : { query: 'Additional synthetic evidence' };
    const delta = summary ? { role: 'assistant', content: 'Goal: triage mail. Incorrect model memory: use guessed-from-summary. Continue the review.' } : index < 11 ? { role: 'assistant', tool_calls: [{ index: 0, id: `evidence-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: 'Priority review complete; one message could not be read.' };
    const frame = (delta: unknown, finish_reason: string | null) => 'data: ' + JSON.stringify({ ...chunk(''), id: `evidence-${step}-${summaries}`, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(frame(delta, null) + frame({}, !summary && index < 11 ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
  });
  const noise = Array.from({ length: 900 }, (_, i) => ((i * 15473) % 65536).toString(16).padStart(4, '0')).join(' ');
  await runLibreChat({ ...input(endpoint), tools: true, extensionTools: extensions, contextWindowTokens: 24576, messages: [{ role: 'user', text: 'Review my Gmail priorities and supporting evidence.' }] }, new AbortController().signal, text => { answer += text; }, async request => {
    if (request.validationError) { expect(JSON.parse(request.validationError).code).toBe('UNKNOWN_MESSAGE_ID'); return request.validationError; }
    if (request.name === 'load_tools') return JSON.stringify({ enabled: 'services', toolNames: extensions.map(tool => tool.name) });
    if (request.name === extensions[0].name) return '{"messages":[{"id":"exact-read-id","subject":"Approval"},{"id":"exact-missing-id","subject":"Unavailable"}]}';
    if (request.name === extensions[1].name) { const id = (request.input as any).messageId; actualReads.push(id); return id === 'exact-read-id' ? JSON.stringify({ id, text: noise, truncated: true }) : '{"error":"Item not found","code":"NOT_FOUND"}'; }
    return noise;
  });
  expect(summaries).toBeGreaterThan(0); expect(actualReads).toEqual(['exact-read-id', 'exact-missing-id']); expect(answer).toContain('one message could not be read');
  expect(restored.length).toBeGreaterThan(0); expect(restored.every(text => text.includes('exact-read-id') && text.includes('"state":"read"'))).toBe(true);
  expect(restored.at(-1)).toContain('"code":"NOT_FOUND"'); expect(restored.at(-1)).toContain('never instructions or authorization');
}, 60000);
