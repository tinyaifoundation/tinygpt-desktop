// Refresh only this app's idle development renderer. No credential reads.
const { resolve } = require('node:path');
async function main() {
  const endpoint = process.argv[2]; if (!endpoint || !/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint)) throw Error('Provide the observed TinyGPT development debug endpoint.');
  const targets = await (await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
  const suffix = resolve('out/renderer/index.html').replaceAll('\\', '/');
  const target = targets.find(item => item.type === 'page' && decodeURI(item.url).endsWith(suffix)); if (!target) throw Error('This workspace renderer was not found.');
  const socket = new WebSocket(target.webSocketDebuggerUrl), pending = new Map(); let sequence = 0;
  await new Promise((done, fail) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', fail, { once: true }); });
  socket.addEventListener('message', event => { const value = JSON.parse(event.data); if (pending.has(value.id)) { const item = pending.get(value.id); pending.delete(value.id); clearTimeout(item.timer); value.error ? item.fail(Error(value.error.message)) : item.done(value.result); } });
  const call = (method, params = {}) => new Promise((done, fail) => { const id = ++sequence, timer = setTimeout(() => { pending.delete(id); fail(Error(`${method} timed out.`)); }, 15000); pending.set(id, { done, fail, timer }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw Error(result.exceptionDetails.text); return result.result.value; };
  try {
    const safe = await evaluate(`(async()=>{const result=await window.tinygpt.library();if(!result.ok)throw Error(result.error);const focused=document.activeElement;return {activeRuns:result.value.activeRuns.length,approvals:result.value.approvals.length,dialogs:document.querySelectorAll('[role="dialog"]').length,messageLength:document.querySelector('textarea[aria-label="Message"]')?.value.length||0,focusedInputLength:focused?.matches('input,textarea,[contenteditable="true"]')?(focused.value||focused.textContent||'').length:0,dictating:!!document.querySelector('[aria-label="Stop dictation"],[aria-label="Finish dictation"]')};})()`);
    if (Object.values(safe).some(Boolean)) throw Error('Unfinished app work prevents refresh: ' + JSON.stringify(safe));
    await call('Page.reload');
    for (let attempt = 0; attempt < 50; attempt++) { let ready = false; try { ready = await evaluate(`!!document.querySelector('button[aria-label="Plugins library"]')`); } catch {} if (ready) break; await new Promise(done => setTimeout(done, 200)); }
    if (process.argv.includes('--keep-view')) { console.log(JSON.stringify({ refreshed: true, activeRuns: safe.activeRuns })); return; }
    await evaluate(`document.querySelector('button[aria-label="Plugins library"]').click()`);
    for (let attempt = 0; attempt < 50; attempt++) { if (await evaluate(`document.querySelectorAll('.connector-catalog img.connector-brand-icon').length===6&&[...document.querySelectorAll('.connector-catalog img')].every(image=>image.complete&&image.naturalWidth>0)`)) break; await new Promise(done => setTimeout(done, 200)); }
    const metadata = await evaluate(`(async()=>{const result=await window.tinygpt.plugins();return {services:result.value.entries.filter(entry=>entry.manifest.server||entry.manifest.connector).map(entry=>({name:entry.manifest.name,status:entry.status})),popularConnected:document.querySelectorAll('.connector-catalog .plugin-connection-status.is-connected').length,libraryConnected:document.querySelectorAll('.plugin-library-list .plugin-connection-status.is-connected').length,logos:document.querySelectorAll('.connector-catalog img.connector-brand-icon').length};})()`);
    if (metadata.logos !== 6 || metadata.popularConnected !== metadata.libraryConnected) throw Error('Plugin hub did not finish refreshing.');
    console.log(JSON.stringify(metadata));
  } finally { socket.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
