const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { resolve, join } = require('node:path');
const { mkdir, writeFile, copyFile } = require('node:fs/promises');
const assert = require('node:assert/strict');

async function main() {
  let app, page; const errors = [], requests = [];
  const profile = resolve('.tools-smoke-profile', `composer-context-${Date.now()}`);
  const fixture = join(profile, 'attachments'); await mkdir(fixture, { recursive: true });
  await writeFile(join(fixture, 'brief.md'), 'ATTACHED_BRIEF_EVIDENCE');
  const stream = 'BT /F1 12 Tf 40 750 Td (ATTACHED_PDF_EVIDENCE) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.4\n'; const offsets = [0]; objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf); pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  await writeFile(join(fixture, 'CP_575_G.pdf'), pdf);
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: 'context-fixture', context_length: 32768 }] })); return; }
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let raw = ''; for await (const part of request) raw += part; const input = JSON.parse(raw);
    const metadata = JSON.stringify(input.messages).includes('Describe a saved conversation');
    if (!metadata) requests.push(input);
    const answer = metadata ? JSON.stringify({ title: 'Linked budget', summary: 'Budget details.', topicChanged: false }) : 'The budget is BLUEBIRD 42.';
    const chunk = { id: 'context-fixture', object: 'chat.completion.chunk', model: 'context-fixture', choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: 'stop' }] };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  async function bridge(method, ...args) { const result = await page.evaluate(({ method, args }) => window.tinygpt[method](...args), { method, args }); assert.equal(result.ok, true, result.error); return result.value; }
  async function wait(predicate, label) { for (let i = 0; i < 300; i++) { if (await predicate()) return; await page.waitForTimeout(50); } throw Error('Timed out: ' + label); }
  async function idle(id) { await wait(async () => !(await bridge('library')).activeRuns.some(run => run.conversationId === id), 'reply complete'); }
  async function menu(side) {
    await page.getByRole('button', { name: 'Add files and tools', exact: true }).click();
    await page.locator('.composer-add-menu').waitFor(); await page.getByRole('textbox', { name: 'Search files, plugins, and conversations' }).fill(''); await page.waitForTimeout(100);
    const metrics = await page.evaluate(() => {
      const composer = document.querySelector('.composer').getBoundingClientRect(), menu = document.querySelector('.composer-add-menu'), rect = menu.getBoundingClientRect(), viewport = menu.querySelector('[data-slot=scroll-area-viewport]');
      return { side: menu.dataset.side, composer: { top: composer.top, bottom: composer.bottom, width: composer.width, left: composer.left }, menu: { top: rect.top, bottom: rect.bottom, width: rect.width, left: rect.left }, height: innerHeight, scrollHeight: viewport.scrollHeight, clientHeight: viewport.clientHeight, overflow: viewport.scrollWidth > viewport.clientWidth + 1 };
    });
    assert.equal(metrics.side, side); assert.ok(Math.abs(metrics.composer.width - metrics.menu.width) <= 1, JSON.stringify(metrics)); assert.ok(Math.abs(metrics.composer.left - metrics.menu.left) <= 1, JSON.stringify(metrics));
    assert.ok(side === 'bottom' ? metrics.menu.top >= metrics.composer.bottom : metrics.menu.bottom <= metrics.composer.top, JSON.stringify(metrics));
    assert.ok(metrics.menu.bottom <= metrics.height && metrics.menu.top >= 0, JSON.stringify(metrics));
    assert.equal(metrics.overflow, false); assert.ok(metrics.scrollHeight > metrics.clientHeight, JSON.stringify(metrics));
    assert.equal(await page.locator('.composer-add-menu [data-slot=scroll-area-scrollbar]').count(), 1);
    return metrics;
  }
  try {
    const env = { ...process.env, TINYGPT_TOOLS_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/tools-smoke-main.cjs')], env, timeout: 60000 });
    page = await app.firstWindow({ timeout: 60000 }); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: 'New chat', exact: true }).waitFor();
    const initial = await bridge('snapshot'); await bridge('saveSettings', { ...initial.settings, mode: 'chat', route: 'local', local: { ...initial.settings.local, endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: 'context-fixture', contextWindowTokens: 32768, tools: true, images: true } });
    const original = await bridge('createConversation', null); await bridge('sendMessage', original.id, 'Remember BLUEBIRD 42.'); await idle(original.id); await bridge('renameConversation', original.id, 'Monitor and model recommendations');
    for (let i = 0; i < 18; i++) { const chat = await bridge('createConversation', null); await bridge('renameConversation', chat.id, `Reference conversation ${i + 1}`); }
    const plugins = await bridge('savePlugin', { manifest: { format: 1, id: 'context-briefing', name: 'Briefing', version: '1.0.0', description: 'Review attached evidence.', kind: 'skill', modes: ['chat', 'bot', 'code'], skills: [{ name: 'briefing', description: 'Read the evidence.', instructions: 'Use attached evidence in your answer.', references: {} }], dependencies: [] }, config: { enabled: true, projectIds: null, rules: {}, resources: [] } });
    const plugin = plugins.entries.find(entry => entry.manifest.id === 'context-briefing'); assert.equal(plugin.status, 'connected');
    await page.evaluate(() => { const key = 'tinygpt-appearance-v4'; localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key)), theme: 'dark' })); });
    await page.reload(); await page.getByRole('button', { name: 'New chat', exact: true }).click();
    const fresh = await menu('bottom'); console.log('New chat menu:', fresh);
    await page.screenshot({ path: resolve('artifacts/composer-context-menu-dark.png') });
    await page.locator('.composer-add-menu section[aria-label="Conversations"] button').last().scrollIntoViewIfNeeded();
    assert.ok(await page.locator('.composer-add-viewport').evaluate(element => element.scrollTop) > 0);
    await page.getByRole('textbox', { name: 'Search files, plugins, and conversations' }).fill('Briefing');
    await page.locator('.composer-add-menu').getByRole('button', { name: /^Briefing/ }).click();
    await page.locator('.composer-reference.is-plugin').waitFor(); await page.keyboard.press('Escape'); await menu('bottom');
    await page.getByRole('textbox', { name: 'Search files, plugins, and conversations' }).fill('Monitor and model');
    await page.locator('.composer-add-menu').getByRole('button', { name: /Monitor and model recommendations/ }).click();
    await page.locator('.composer-reference.is-conversation').waitFor();
    let current = (await bridge('library')).lastConversationId;
    assert.ok((await bridge('conversation', current)).sources.some(source => source.kind === 'conversation'));
    await page.locator('.composer-reference.is-plugin').waitFor();
    assert.ok((await bridge('pluginSelection', current, null)).includes(plugin.id));
    await copyFile(resolve('src/main/assets/dock-icons/tinygpt-ios-default.png'), join(fixture, 'preview.png'));
    await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, [join(fixture, 'preview.png'), join(fixture, 'CP_575_G.pdf')]);
    await menu('bottom'); await page.getByRole('textbox', { name: 'Search files, plugins, and conversations' }).fill(''); await page.getByRole('button', { name: 'Attach files or images', exact: true }).click();
    await page.locator('.composer-attachment img').waitFor(); assert.equal(await page.locator('.composer-attachment').count(), 2);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Use these references to write a brief.');
    await page.mouse.move(0, 0); await page.screenshot({ path: resolve('artifacts/composer-context-preview-dark.png') });
    const references = await page.locator('.composer-reference').evaluateAll(elements => elements.map(element => ({ background: getComputedStyle(element).backgroundColor, border: getComputedStyle(element).borderTopWidth, color: getComputedStyle(element).color })));
    assert.ok(references.every(reference => reference.background === 'rgba(0, 0, 0, 0)' && reference.border === '0px')); assert.notEqual(references[0].color, references[1].color);
    await page.reload(); await page.locator('.composer-attachment img').waitFor(); await page.locator('.composer-reference.is-plugin').waitFor();
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, fixture);
    await menu('bottom'); await page.getByRole('button', { name: 'Attach a folder', exact: true }).click(); await page.getByRole('button', { name: 'Preview attachments', exact: true }).waitFor();
    await page.evaluate(() => { const key = 'tinygpt-appearance-v4'; localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key)), theme: 'light' })); }); await page.reload();
    await page.locator('html[data-theme="light"]').waitFor(); await page.locator('.composer-attachment img').waitFor(); await page.waitForTimeout(500); await page.screenshot({ path: resolve('artifacts/composer-context-preview-light.png') });
    await page.getByRole('button', { name: 'Send message', exact: true }).click(); await idle(current);
    const sent = await bridge('conversation', current); assert.equal(sent.messages[0].attachmentIds.length, 4); assert.equal(await page.locator('.composer-reference.is-conversation').count(), 0);
    assert.ok(JSON.stringify(requests.at(-1).messages).includes('BLUEBIRD 42')); assert.ok(JSON.stringify(requests.at(-1).messages).includes('ATTACHED_BRIEF_EVIDENCE')); assert.ok(JSON.stringify(requests.at(-1).messages).includes('ATTACHED_PDF_EVIDENCE')); assert.ok(requests.at(-1).tools.some(tool => tool.function.description.includes('Briefing')));
    console.log('Existing chat menu:', await menu('top')); await page.screenshot({ path: resolve('artifacts/composer-context-menu-light.png') }); await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Remove plugin Briefing', exact: true }).click(); await wait(async () => !(await bridge('pluginSelection', current, null)).includes(plugin.id), 'plugin removal saved');
    await page.getByRole('button', { name: 'New chat', exact: true }).click(); await page.getByRole('tab', { name: 'Work', exact: true }).click(); await menu('bottom'); await page.keyboard.press('Escape');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => !window.isDestroyed()).setSize(900, 720)); await page.waitForTimeout(500);
    console.log('Narrow Work menu:', await menu('bottom')); await page.screenshot({ path: resolve('artifacts/composer-context-menu-narrow.png') });
    assert.deepEqual(errors, []); console.log('Composer context smoke passed: full-width directed menus, ShadCN scrolling, image/file/folder previews, persistent conversation and plugin references, inference context, Chat and Work.');
  } catch (error) { if (page) { await page.screenshot({ path: resolve('artifacts/composer-context-failure.png') }).catch(() => {}); console.log(await page.locator('body').innerText().catch(() => '')); } throw error; }
  finally { if (app) await app.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
