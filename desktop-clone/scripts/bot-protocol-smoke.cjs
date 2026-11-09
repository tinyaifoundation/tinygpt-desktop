const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');

function events(response, list) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  response.end(list.map((event, index) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`).join(''));
}
async function main() {
  let app; const seen = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    seen.push({ url: request.url, key: request.headers['x-api-key'] ?? request.headers.authorization, body: JSON.parse(raw) });
    if (request.url === '/v1/chat/completions') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (text, end = false) => JSON.stringify({ id: 'chatcmpl_fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: end ? {} : { role: 'assistant', content: text }, finish_reason: end ? 'stop' : null }] });
      response.end(`data: ${chunk('Chat Completions worker reply.')}\n\ndata: ${chunk('', true)}\n\ndata: [DONE]\n\n`); return;
    }
    if (request.url === '/v1/messages') {
      events(response, [
        { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', content: [], model: 'fixture', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Anthropic worker reply.' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      ]); return;
    }
    if (request.url === '/v1/responses') {
      const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'in_progress', content: [] };
      const base = { id: 'resp_fixture', object: 'response', created_at: 1, model: 'fixture', status: 'in_progress', output: [], error: null, incomplete_details: null };
      const part = { type: 'output_text', text: 'Responses worker reply.', annotations: [] };
      events(response, [
        { type: 'response.created', response: base },
        { type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { ...part, text: '' } },
        { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: part.text },
        { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: part.text },
        { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part },
        { type: 'response.output_item.done', output_index: 0, item: { ...item, status: 'completed', content: [part] } },
        { type: 'response.completed', response: { ...base, status: 'completed', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, output: [{ ...item, status: 'completed', content: [part] }] } },
      ]); return;
    }
    response.writeHead(404).end();
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  const environment = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve(".tools-smoke-profile", "bot-protocols-" + Date.now()) }; delete environment.ELECTRON_RUN_AS_NODE;
  try {
    app = await _electron.launch({ executablePath: resolve(process.env.TINYGPT_SMOKE_EXECUTABLE || 'node_modules/electron/dist/electron.exe'), args: [resolve('scripts/bot-conversation-smoke-main.cjs')], env: environment, timeout: 30000 });
    const page = await app.firstWindow(); await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    for (const protocol of ['openai-compatible', 'anthropic', 'openai-responses']) {
      const started = await page.evaluate(async ({ endpoint, protocol }) => {
        const current = await window.tinygpt.snapshot();
        const saved = await window.tinygpt.saveSettings({ ...current.value.settings, mode: 'bot', route: 'byok', byok: { endpoint, protocol, provider: 'custom', model: 'fixture', tools: false, contextWindowTokens: 64000 } });
        if (!saved.ok) return saved;
        const key = await window.tinygpt.saveSecret('byok', 'fixture-protocol-key'); if (!key.ok) return key;
        const prepared = await window.tinygpt.prepareBot({name: "Protocol Bot", projectId: null}); if (!prepared.ok) return prepared; const conversation = await window.tinygpt.completeBot({name: "Protocol Bot", projectId: null}); if (!conversation.ok) return conversation;
        return window.tinygpt.sendMessage(conversation.value.id, 'Test the packaged provider protocol');
      }, { endpoint, protocol }); assert.equal(started.ok, true, JSON.stringify(started));
      let finished;
      for (let attempt = 0; attempt < 600; attempt++) {
        finished = await page.evaluate(id => window.tinygpt.conversation(id), started.value.conversation.id);
        assert.equal(finished.ok, true);
        if (finished.value.messages.at(-1).status !== 'streaming') break;
        await new Promise(done => setTimeout(done, 100));
      }
      assert.equal(finished.value.messages.at(-1).status, 'complete', JSON.stringify(finished.value.messages.at(-1)));
      assert.equal(finished.value.messages.at(-1).text, { 'openai-compatible': 'Chat Completions worker reply.', anthropic: 'Anthropic worker reply.', 'openai-responses': 'Responses worker reply.' }[protocol]);
      console.log('Bot protocol passed:', protocol);
    }
    for (const [path, key] of [['/v1/chat/completions', 'Bearer fixture-protocol-key'], ['/v1/messages', 'fixture-protocol-key'], ['/v1/responses', 'Bearer fixture-protocol-key']]) {
      const request = seen.find(request => request.url === path && JSON.stringify(request.body).includes('TinyGPT supplemental context:'));
      assert.ok(request, `Missing actual Bot provider request: ${path}`); assert.equal(request.key, key); assert.equal(request.body.tools, undefined);
    }
    console.log('Bot protocol smoke passed: actual OpenClaw runtime with Chat Completions, Anthropic Messages, and OpenAI Responses.');
  } finally {
    if (app) await app.close(); server.closeAllConnections(); await new Promise(done => server.close(done));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
