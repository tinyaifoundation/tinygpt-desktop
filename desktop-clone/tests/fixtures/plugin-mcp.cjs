// Protocol fixture: runs as an actual separately supervised stdio process.
const readline = require('node:readline');
const fs = require('node:fs');
function send(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line); if (message.id === undefined) return;
  const input = message.params || {};
  switch (message.method) {
    case 'initialize': send(message.id, { protocolVersion: '2025-11-25', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'TinyGPT fixture', version: '1.0.0' } }); break;
    case 'ping': send(message.id, {}); break;
    case 'tools/list': send(message.id, { tools: [{ name: 'echo', description: 'Echo a string with status as a real argument.', inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: 200 }, status: { type: 'string' } }, required: ['text'], additionalProperties: false } }, { name: 'mutate', description: 'Write a marker to prove approved execution.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }); break;
    case 'tools/call': if (input.name === 'mutate') fs.writeFileSync(process.argv[2], 'approved'); send(message.id, { content: [{ type: 'text', text: input.name === 'echo' ? JSON.stringify(input.arguments) : 'Marker written.' }] }); break;
    case 'resources/list': send(message.id, { resources: [{ uri: 'fixture://release', name: 'Release rules', mimeType: 'text/markdown' }] }); break;
    case 'resources/read': send(message.id, { contents: [{ uri: input.uri, text: 'Project releases require two maintainer signatures.' }] }); break;
    case 'prompts/list': send(message.id, { prompts: [{ name: 'brief', description: 'Write a short brief.' }] }); break;
    case 'prompts/get': send(message.id, { messages: [{ role: 'user', content: { type: 'text', text: 'Write a brief with actual evidence.' } }] }); break;
    default: process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unknown method' } }) + '\n');
  }
});
