// Offline only: the real SDK serializes saved native history into a fake fetch.
// Output contains counts and difference locations, never conversation content.
import { readFile } from 'node:fs/promises';
import { buildSessionProjection, convertToLlm } from '@earendil-works/pi-coding-agent';
import { stream } from '@earendil-works/pi-ai/api/openai-completions';

const file = process.argv[2];
if (!file) throw Error('Pass a saved native Pi session JSONL path.');
const entries = (await readFile(file, 'utf8')).trim().split('\n').flatMap(line => { try { const e = JSON.parse(line); return e.type === 'session' ? [] : [e]; } catch { return []; } });
const model = { api: 'openai-completions', provider: 'tinygpt', id: 'tinygpt-pro', name: 'Offline audit', baseUrl: 'http://127.0.0.1:9/v1', reasoning: true, input: ['text'], contextWindow: 65536, maxTokens: 16384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens' } };
let previous;
for (let index = 0; index < entries.length; index++) {
  const e = entries[index]; if (e.message?.role !== 'assistant' || e.message.usage?.input < 40000) continue;
  const projection = buildSessionProjection(entries.slice(0, index));
  let payload;
  await stream(model, { messages: convertToLlm(projection.messages) }, {
    apiKey: 'offline-fixture', maxRetries: 0,
    onPayload: value => { payload = value; },
    fetch: async () => new Response('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }),
  }).result();
  if (!payload) throw Error('No SDK payload captured.');
  const chars = { instructions: 0, user: 0, assistantText: 0, reasoning: 0, toolArguments: 0, toolResults: 0, toolDefinitions: JSON.stringify(payload.tools ?? []).length };
  for (const m of payload.messages) {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
    if (m.role === 'system' || m.role === 'developer') chars.instructions += content.length;
    if (m.role === 'user') chars.user += content.length;
    if (m.role === 'tool') chars.toolResults += content.length;
    if (m.role === 'assistant') { chars.assistantText += content.length; chars.reasoning += (m.reasoning_content ?? '').length; chars.toolArguments += JSON.stringify(m.tool_calls ?? []).length; }
  }
  const messageText = JSON.stringify(payload.messages);
  let commonChars = 0;
  if (previous) while (commonChars < Math.min(previous.length, messageText.length) && previous[commonChars] === messageText[commonChars]) commonChars++;
  let changedMessageIndex = null;
  if (previous) { const old = JSON.parse(previous); changedMessageIndex = payload.messages.findIndex((m, i) => JSON.stringify(m) !== JSON.stringify(old[i])); }
  console.log(JSON.stringify({ at: e.timestamp, observedInputTokens: e.message.usage.input, chars, messageCount: payload.messages.length, commonMessagePrefixCharacters: previous ? commonChars : null, changedMessageIndex }));
  previous = messageText;
}
