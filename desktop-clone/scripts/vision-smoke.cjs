const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { resolve, join } = require('node:path');
const { mkdir, writeFile } = require('node:fs/promises');
const assert = require('node:assert/strict');
async function main() {
  const profile = resolve('.tools-smoke-profile', 'vision-' + Date.now());
  const folder = join(profile, 'repo'); await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'design.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64'));
  const bodies = []; let stage = 0; let tabId; let reference;
  const server = createServer(async (request, response) => {
    if (request.url === '/page') { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Vision fixture</title><style>body{background:#155ac3;color:white}h1{font:48px sans-serif}</style><h1>Browser screenshot fixture</h1>'); return; }
    let raw = ''; for await (const part of request) raw += part;
    const body = JSON.parse(raw); bodies.push(body);
    const names = (body.tools || []).map(tool => tool.function.name);
    let name, args;
    const toolResult = body.messages.filter(message => message.role === 'tool').at(-1);
    const resultText = typeof toolResult?.content === 'string' ? toolResult.content : toolResult?.content?.filter(part => part.type === 'text').map(part => part.text).join('');
    let result; try { result = JSON.parse(resultText); } catch {}
    if (stage === 0) { name = names.find(name => name.endsWith('_view_image')); args = { image: 'design.png' }; }
    if (stage === 1) { name = names.find(name => name.endsWith('_browser_open')); args = { url: 'http://127.0.0.1:' + server.address().port + '/page' }; }
    if (stage === 2) { tabId = result?.tabId; name = names.find(name => name.endsWith('_browser_screenshot')); args = { tabId }; }
    if (stage === 3) { reference = result?.imageReference; name = names.find(name => name.endsWith('_view_image')); args = { image: reference }; }
    const n = stage++;
    const delta = name ? { role: 'assistant', tool_calls: [{ index: 0, id: 'vision_' + n, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: 'Viewed the image and the browser screenshot.' };
    const frame = (delta, finish_reason) => ({ id: 'chatcmpl-vision-' + n, object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end('data: ' + JSON.stringify(frame(delta, null)) + '\n\ndata: ' + JSON.stringify(frame({}, name ? 'tool_calls' : 'stop')) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  let app;
  try {
    const env = { ...process.env, TINYGPT_TOOLS_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/tools-smoke-main.cjs')], env });
    const page = await app.firstWindow(); const errors = []; page.on('pageerror', error => errors.push(error.message));
    const fixtureImage = await app.evaluate(({ nativeImage }) => nativeImage.createFromBitmap(Buffer.alloc(64 * 64 * 4, 255), { width: 64, height: 64 }).toDataURL());
    await writeFile(join(folder, 'design.png'), Buffer.from(fixtureImage.split(',')[1], 'base64'));
    await app.evaluate(({ dialog, BrowserWindow }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); for (const window of BrowserWindow.getAllWindows()) { window.setPosition(-10000, -10000); window.showInactive(); window.webContents.setBackgroundThrottling(false); } }, folder);
    await page.getByRole('button', { name: 'New chat', exact: true }).waitFor();
    const conversationId = await page.evaluate(async endpoint => {
      const b = window.tinygpt; const settings = (await b.snapshot()).value.settings;
      const saved = await b.saveSettings({ ...settings, mode: 'code', route: 'local', local: { ...settings.local, endpoint, model: 'fixture', tools: true, images: true, contextWindowTokens: 131072 }, toolPermissions: { read: 'allow', write: 'allow', browser: 'allow', interact: 'allow', execute: 'allow' } }); if (!saved.ok) throw Error(saved.error);
      const chosen = await b.chooseNewProjectFolder(); const project = await b.createProject('Vision fixture', '', false, chosen.value.id); const chat = await b.createConversation(project.value.id);
      const sent = await b.sendMessage(chat.value.id, 'Inspect design.png, then open the browser and capture and inspect its screenshot.', []); if (!sent.ok) throw Error(sent.error); return chat.value.id;
    }, 'http://127.0.0.1:' + server.address().port + '/v1');
    await page.reload();
    const until = Date.now() + 90000;
    while (Date.now() < until && await page.evaluate(async () => (await window.tinygpt.library()).value.activeRuns.length > 0)) await new Promise(done => setTimeout(done, 150));
    const chat = await page.evaluate(async id => (await window.tinygpt.conversation(id)).value, conversationId);
    assert.equal(chat.messages.at(-1).status, 'complete', chat.messages.at(-1).error);
    assert.equal(stage, 5, 'All four vision/browser operations must execute');
    assert.ok(tabId && reference, 'Saved screenshot reference');
    assert.ok(chat.tools.every(tool => tool.status === 'success'), JSON.stringify(chat.tools.map(tool => ({ name: tool.name, status: tool.status, result: tool.status !== 'success' ? tool.result : undefined }))));
    assert.equal(await page.getByRole('button', { name: 'Show workspace', exact: true }).getAttribute('aria-pressed'), 'false', 'Browser tools do not open the workspace');
    assert.ok(!JSON.stringify(bodies[0].messages).includes('base64'), 'Initial request contains no pixels');
    const pixelBodies = bodies.filter(body => JSON.stringify(body.messages).includes('data:image/'));
    if (pixelBodies.length < 2) console.log(JSON.stringify({tools: chat.tools, contentTypes: bodies.map(body => body.messages.map(message => ({role: message.role, types: Array.isArray(message.content) ? message.content.map(part => part.type) : 'text'})))}));
    assert.ok(pixelBodies.length >= 2, 'Native Work model receives actual normalized pixels');
    assert.equal(chat.tools.filter(tool => ['view_image', 'browser_screenshot'].includes(tool.name)).length, 3);
    assert.ok(chat.tools.every(tool => !tool.result?.includes('base64')), 'History stores only metadata');
    const sources = (await page.evaluate(async id => (await window.tinygpt.conversation(id)).value.sources, conversationId));
    const screenshot = sources.find(source => source.id === reference.split(':')[1]); assert.ok(screenshot);
    const detail = await page.evaluate(async ({ conversationId, sourceId }) => (await window.tinygpt.source(conversationId, sourceId)).value, { conversationId, sourceId: screenshot.id });
    assert.ok(detail?.image?.startsWith('data:image/'));
    const response = page.locator('[data-slot="work-response"]').last();
    assert.equal(await response.locator('.work-response-heading').getAttribute('aria-expanded'), 'false');
    assert.ok(await response.locator('.work-response-divider').isVisible(), 'Collapsed timer retains divider');
    const footer = page.locator('[data-slot="answer-actions"]').last();
    await page.mouse.move(1, 1); assert.equal(await footer.evaluate(element => getComputedStyle(element).opacity), '0');
    await footer.hover(); await page.waitForTimeout(180); assert.equal(await footer.evaluate(element => getComputedStyle(element).opacity), '1');
    assert.ok(await footer.locator('time').count(), 'Work footer includes timestamp');
    await page.evaluate(async () => { const b = window.tinygpt; const settings = (await b.snapshot()).value.settings; const saved = await b.saveSettings({ ...settings, local: { ...settings.local, images: false } }); if (!saved.ok) throw Error(saved.error); });
    await page.evaluate(async id => { const r = await window.tinygpt.sendMessage(id, 'A text-only follow-up.', []); if (!r.ok) throw Error(r.error); }, conversationId);
    while (Date.now() < until && await page.evaluate(async () => (await window.tinygpt.library()).value.activeRuns.length > 0)) await new Promise(done => setTimeout(done, 150));
    assert.ok(!bodies.at(-1).tools.some(tool => /_(view_image|browser_screenshot)$/.test(tool.function.name)), 'Text-only Work removes vision tools');
    assert.ok(!JSON.stringify(bodies.at(-1).messages).includes('base64'), 'Text-only follow-up has no pixels');
    assert.deepEqual(errors, []); console.log(JSON.stringify({ checks: ['native Work MCP pixels', 'real browser screenshot', 'saved references', 'metadata-only history', 'text-only capability gating', 'collapsed divider', 'footer hover and timestamp'], calls: stage, errors }));
  } finally { if (app) await app.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
