const { app } = require('electron');
const { mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const profile = resolve(process.env.TINYGPT_TOOLS_PROFILE);
mkdirSync(profile, { recursive: true }); app.setPath('userData', profile);
app.setAppPath(resolve(__dirname, '..'));
app.on('browser-window-created', (_event, window) => window.hide());
// Only this disposable fixture can opt into upstream startup diagnostics.
if (process.env.TINYGPT_BOT_PROOF_DEBUG === '1') {
  const WebSocket = require('ws'), emit = WebSocket.prototype.emit, send = WebSocket.prototype.send, methods = new Map();
  WebSocket.prototype.send = function(data, ...args) { try { const frame = JSON.parse(String(data)); if (frame.type === 'req' && frame.method?.includes('approval')) { methods.set(frame.id, frame.method); process.stderr.write(`Native request: ${JSON.stringify(frame)}\n`); } } catch {} return send.call(this, data, ...args); };
  WebSocket.prototype.emit = function(event, ...args) {
    if (event === 'message') { try { const frame = JSON.parse(String(args[0])); if (frame.type === 'res' && methods.has(frame.id)) process.stderr.write(`Native response: ${methods.get(frame.id)} ${JSON.stringify(frame)}\n`); if (frame.type === 'event' && ['agent', 'chat', 'exec.approval.requested', 'exec.approval.resolved'].includes(frame.event)) process.stderr.write(`Native event: ${JSON.stringify(frame).slice(0, 1600)}\n`); } catch {} }
    return emit.call(this, event, ...args);
  };
  const childProcess = require('node:child_process'), original = childProcess.fork;
  childProcess.fork = (...args) => {
    if (args[0].endsWith('host.mjs')) {
      args[2].env.TINYGPT_BOT_PROOF_DEBUG = '1';
      const fs = require('node:fs'), path = args[2].env.OPENCLAW_CONFIG_PATH;
      const config = JSON.parse(fs.readFileSync(path, 'utf8')); config.logging = { level: 'warn', consoleLevel: 'warn' }; fs.writeFileSync(path, JSON.stringify(config));
    }
    const child = original(...args);
    if (args[0].endsWith('host.mjs')) { child.stderr?.on('data', chunk => process.stderr.write(chunk)); child.stdout?.on('data', chunk => process.stderr.write(chunk)); }
    return child;
  };
}
require('../out/main/index.js');
