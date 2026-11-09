// Real packaged Chromium and LibreChat; network traffic uses test-owned fixtures only.
const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { mkdir, writeFile, readFile } = require('node:fs/promises');
const { resolve, join } = require('node:path');
const assert = require('node:assert/strict');
function pdfFixture() {
  const stream = 'BT /F1 12 Tf 72 720 Td (PDF BLUEBIRD evidence) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let result = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(result)); result += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(result); result += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return result;
}
async function main() {
  let app; let origin; const requests = []; const errors = []; let submits = 0;
  const fixtureRoot = resolve('.tools-smoke-fixtures', String(Date.now())); await mkdir(fixtureRoot, { recursive: true });
  await writeFile(join(fixtureRoot, 'brief.md'), 'ATTACHMENT BLUEBIRD brief says launch Thursday.');
  await writeFile(join(fixtureRoot, 'evidence.pdf'), pdfFixture());
  await writeFile(join(fixtureRoot, 'project.md'), 'PROJECT BLUEBIRD source says testing Friday.');
  const server = createServer(async (request, response) => {
    if (request.url === '/article') { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Rendered article</title><main><h1>Article</h1><p id="content">Loading</p></main><script>document.getElementById("content").textContent="CHROMIUM BLUEBIRD rendered after JavaScript"</script>'); return; }
    if (request.url === '/challenge') { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Verify you are human</title><main><h1 id="title">Verify you are human</h1><button onclick="document.title=\'Verified article\';document.getElementById(\'title\').textContent=\'HANDOFF BLUEBIRD verification completed\';this.remove()">Complete verification</button></main>'); return; }
    if (request.url === '/form') { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Local form</title><main><input aria-label="Work note"><button onclick="fetch(\'/submit\');document.getElementById(\'result\').textContent=\'Submitted \'+document.querySelector(\'input\').value">Save note</button><p id="result">Not submitted</p></main>'); return; }
    if (request.url === '/submit') { submits++; response.end('OK'); return; }
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let raw = ''; for await (const chunk of request) raw += chunk; const body = JSON.parse(raw); requests.push(body);
    const user = body.messages.filter(m => m.role === 'user').at(-1).content;
    const text = typeof user === 'string' ? user : user.filter(c => c.type === 'text').map(c => c.text).join(' ');
    const toolMessages = body.messages.filter(m => m.role === 'tool'); const last = toolMessages.at(-1); const result = last ? JSON.parse(last.content) : null;
    let tool; let answer = 'Attachments received and inspected.';
    if (/Read Project file/.test(text)) { if (!last) tool = ['read_project_file', { path: 'project.md' }]; else answer = `Project source received. ${result.citation || result.error}`; }
    if (/Write approved file/.test(text)) { if (!last) tool = ['write_project_file', { path: 'approved.md', content: 'APPROVED BLUEBIRD file content' }]; else answer = result.error ? `Write declined: ${result.error}` : 'Approved file written.'; }
    if (/Browser exercise/.test(text)) {
      if (!last) tool = ['read_page', { url: `${origin}/form` }];
      else if (result.error) answer = `Browser action declined: ${result.error}`;
      else if (toolMessages.length === 1) tool = ['browser_type', { tabId: result.tabId, elementId: result.elements.find(e => e.label === 'Work note').id, text: 'BLUEBIRD note' }];
      else if (toolMessages.length === 2) tool = ['browser_click', { tabId: result.tabId, elementId: result.elements.find(e => e.label === 'Save note').id }];
      else answer = result.text;
    }
    if (/Search saved evidence/.test(text)) { if (!last) tool = ['search_sources', { query: 'BLUEBIRD' }]; else answer = `Saved evidence found. ${result.passages[0]?.citation || 'No passages.'}`; }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name: tool[0], arguments: JSON.stringify(tool[1]) } }] } : { role: 'assistant', content: answer };
    const event = (delta, finish_reason) => JSON.stringify({ id: `chatcmpl-tools-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'tools-fixture', choices: [{ index: 0, delta, finish_reason }] });
    response.end(`data: ${event(delta, null)}\n\ndata: ${event({}, tool ? 'tool_calls' : 'stop')}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done)); origin = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', String(Date.now())) }; delete env.ELECTRON_RUN_AS_NODE;
  async function bridge(page, method, ...args) { const result = await page.evaluate(async ({ method, args }) => window.tinygpt[method](...args), { method, args }); assert.equal(result.ok, true, result.error); return result.value; }
  async function idle(page) {
    for (let i = 0; i < 200; i++) { const library = await bridge(page, 'library'); if (!library.activeRuns[0]) return library; await new Promise(done => setTimeout(done, 100)); }
    throw new Error('Tools did not finish.');
  }
  async function prompt(page, text) { await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text); await page.getByRole('button', { name: 'Send message', exact: true }).click(); }
  try {
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/tools-smoke-main.cjs')], env, timeout: 30000 });
    const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    const snapshot = await bridge(page, 'snapshot'); await bridge(page, 'saveSettings', { ...snapshot.settings, mode: 'chat', route: 'local', local: { ...snapshot.settings.local, endpoint: `${origin}/v1`, model: 'tools-fixture', tools: true, images: true }, toolPermissions: { ...snapshot.settings.toolPermissions, read: 'allow', browser: 'allow', interact: 'ask', write: 'ask' } });
    await page.reload();
    // Native file picker and real PDF/image decoding. Only fixture files are selected.
    const imagePath = join(fixtureRoot, 'picture.png');
    const imageBytes = await app.evaluate(({ nativeImage }) => Array.from(nativeImage.createFromBitmap(Buffer.from([0, 0, 0, 255]), { width: 1, height: 1 }).toPNG()));
    await writeFile(imagePath, Buffer.from(imageBytes));
    await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, [join(fixtureRoot, 'brief.md'), join(fixtureRoot, 'evidence.pdf'), imagePath]);
    await page.getByRole('button', { name: 'Add files and tools', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Attach', exact: true }).click();
    await page.getByRole('button', { name: 'Remove attachment evidence.pdf', exact: true }).waitFor({ timeout: 30000 });
    const library = await bridge(page, 'library'); const attachmentConversation = library.lastConversationId;
    await prompt(page, 'Review these attachments'); await idle(page);
    const attachmentRequest = requests.at(-1); const content = attachmentRequest.messages.at(-1).content;
    assert.equal(Array.isArray(content), true); assert.equal(content.some(part => part.type === 'image_url' && part.image_url.url.startsWith('data:image/jpeg;base64,')), true);
    assert.equal(content.some(part => part.type === 'text' && part.text.includes('PDF BLUEBIRD evidence') && part.text.includes('launch Thursday')), true);
    assert.equal((await bridge(page, 'conversation', attachmentConversation)).sources.every(source => source.messageId), true);
    console.log('Native text/PDF/image attachments passed.');
    await page.getByRole('button', { name: 'Show workspace', exact: true }).click(); await page.getByRole('complementary', {name:'Workspace', exact:true}).getByRole('button', {name:'Sources', exact:true}).click(); await page.getByRole('textbox', { name: 'Search saved sources' }).fill('BLUEBIRD'); await page.getByRole('button', { name: 'Search sources', exact: true }).click();
    await page.getByRole('button', { name: /evidence.pdf.*PDF BLUEBIRD/s }).waitFor(); await page.getByRole('button', { name: 'Close sources', exact: true }).click();
    // Project folder tools use the user's granted folder, through the actual worker.
    const project = await bridge(page, 'createProject', 'Tool smoke Project', 'Use local sources.', false);
    await app.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, fixtureRoot);
    await bridge(page, 'chooseProjectFolder', project.id); await page.reload();
    await page.getByRole('button', { name: 'Tool smoke Project', exact: true }).hover();
    await page.getByRole('button', { name: 'New chat in Tool smoke Project', exact: true }).click();
    await prompt(page, 'Read Project file'); const afterRead = await idle(page); const id = afterRead.lastConversationId;
    let conversation = await bridge(page, 'conversation', id); assert.equal(conversation.tools.at(-1).status, 'success'); assert.equal(conversation.messages.at(-1).text.includes('tinygpt-source:'), true);
    await page.getByRole('button', { name: 'Citation 1: project.md', exact: true }).hover(); await page.getByRole('button', { name: 'Open source: project.md', exact: true }).click(); await page.getByLabel('Saved sources').getByText('PROJECT BLUEBIRD source says testing Friday.', { exact: true }).waitFor(); await page.getByRole('button', { name: 'Close sources', exact: true }).click();
    await prompt(page, 'Write approved file'); await page.getByRole('region', { name: 'Tool approval', exact: true }).waitFor();
    assert.equal(await readFile(join(fixtureRoot, 'approved.md'), 'utf8').catch(() => null), null);
    await page.getByRole('button', { name: 'Deny', exact: true }).click(); await idle(page); assert.equal(await readFile(join(fixtureRoot, 'approved.md'), 'utf8').catch(() => null), null);
    await prompt(page, 'Write approved file'); await page.getByRole('region', { name: 'Tool approval', exact: true }).waitFor(); await page.getByRole('button', { name: 'Allow once', exact: true }).click(); await idle(page);
    assert.equal(await readFile(join(fixtureRoot, 'approved.md'), 'utf8'), 'APPROVED BLUEBIRD file content');
    console.log('Project read/citation and deny/approved writes passed.');
    // The harness and visible workspace share the same Chromium pages.
    const article = await bridge(page, 'readPage', id, `${origin}/article`); assert.match(article.page.text, /CHROMIUM BLUEBIRD rendered after JavaScript/);
    await bridge(page, 'revealBrowser', id, article.page.tabId); await page.getByRole('textbox', {name:'Search or enter a URL'}).waitFor();
    conversation = await bridge(page, 'conversation', id); assert.equal(conversation.sources.some(source => source.title === 'Rendered article'), true);
    // Search parser fixtures run in the Electron Chromium engine at actual engine URLs.
    await app.evaluate(({ session }, origin) => {
      const browser = session.fromPartition('persist:tinygpt-browser');
      browser.protocol.handle('https', () => new Response(`<title>Search results</title><main><div id="search"><div class="g"><a href="${origin}/article"><h3>Fixture result</h3></a>Fixture snippet</div></div><div id="b_results"><div class="b_algo"><h2><a href="${origin}/article">Fixture result</a></h2>Fixture snippet</div></div><div class="snippet"><a class="heading-serpresult" href="${origin}/article">Fixture result</a></div><article><a data-testid="result-title-a" href="${origin}/article">Fixture result</a></article></main>`, { headers: { 'Content-Type': 'text/html' } }));
    }, origin);
    for (const engine of ['google', 'bing', 'brave', 'duckduckgo']) { const result = await bridge(page, 'searchWeb', id, 'BLUEBIRD', engine); assert.equal(result.results.length, 1); assert.equal(result.results[0].url, `${origin}/article`); }
    // Verification is completed in the same owned WebContentsView, then the harness resumes.
    const reading = bridge(page, 'readPage', id, `${origin}/challenge`);
    await page.getByRole('button', {name:'Resume task',exact:true}).waitFor();
    const handoff = (await bridge(page, 'library')).browserHandoffs[0]; assert.ok(handoff.tabId);
    const originalContents = await app.evaluate(({webContents},url)=>webContents.getAllWebContents().find(content=>content.getURL()===url).id,`${origin}/challenge`);
    await app.evaluate(async ({webContents},id)=>webContents.fromId(id).executeJavaScript('document.querySelector("button").click()'),originalContents);
    await page.getByRole('button',{name:'Resume task',exact:true}).click(); const verified=await reading; assert.match(verified.page.text,/HANDOFF BLUEBIRD verification completed/);
    assert.equal(await app.evaluate(({webContents},id)=>webContents.fromId(id).id,originalContents),originalContents); assert.equal((await bridge(page,'library')).browserHandoffs.length,0);
    await page.getByRole('button',{name:'Close workspace',exact:true}).click();
    console.log('Chromium rendered-page extraction, engine parser fixtures and same-tab handoff passed.');
    // Agent typing and clicks need separate approval before touching the page.
    await prompt(page, 'Browser exercise'); await page.getByRole('region', { name: 'Tool approval', exact: true }).waitFor(); assert.equal(submits, 0);
    await page.getByRole('button', { name: 'Allow once', exact: true }).click(); await page.getByRole('region', { name: 'Tool approval', exact: true }).getByText(/Save note/).waitFor(); assert.equal(submits, 0);
    await page.getByRole('button', { name: 'Allow once', exact: true }).click(); await idle(page); assert.equal(submits, 1);
    conversation = await bridge(page, 'conversation', id); assert.equal(conversation.messages.at(-1).text.includes('Submitted BLUEBIRD note'), true);
    // Stop while waiting must clear the approval and leave a cancelled reply.
    await prompt(page, 'Write approved file'); await page.getByRole('region', { name: 'Tool approval', exact: true }).waitFor(); await page.getByRole('button', { name: 'Stop reply', exact: true }).click(); await idle(page);
    assert.equal((await bridge(page, 'library')).approvals.length, 0); assert.equal((await bridge(page, 'conversation', id)).messages.at(-1).status, 'cancelled');
    await prompt(page, 'Search saved evidence'); await idle(page); conversation = await bridge(page, 'conversation', id); assert.equal(conversation.messages.at(-1).text.includes('tinygpt-source:'), true);
    // Persistent profile separation is verified without reading the user's browser data.
    const cookies = await app.evaluate(async ({ session }) => {
      const shared = session.fromPartition('persist:tinygpt-browser'); const isolated = session.fromPartition('persist:tinygpt-browser-test-isolated');
      await shared.cookies.set({ url: 'https://example.com', name: 'fixture', value: 'shared' }); return { shared: await shared.cookies.get({ name: 'fixture' }), isolated: await isolated.cookies.get({ name: 'fixture' }) };
    }); assert.equal(cookies.shared.length, 1); assert.equal(cookies.isolated.length, 0);
    await mkdir(resolve('artifacts'), { recursive: true }); await page.screenshot({ path: resolve('artifacts/tools.png') }); assert.deepEqual(errors, []);
    console.log('Tools smoke passed: native attachments, PDF/image decoding, real LibreChat tool round trips, scoped file read/write, deny/approve/stop, citations and local retrieval, JavaScript-rendered Chromium pages, four engine parser fixtures, same-tab verification handoff, browser type/click approvals and isolated cookies.');
  } catch (error) {
    if (app) { const page = app.windows()[0]; if (page) { console.error('Desktop alerts:', await page.getByRole('alert').allTextContents()); const library = await bridge(page, 'library'); const conversation = await bridge(page, 'conversation', library.lastConversationId); console.error('Recent fixture tools:', conversation.tools.slice(-4)); console.error('Recent fixture request roles:', requests.at(-1)?.messages.map(message => message.role)); await mkdir(resolve('artifacts'), { recursive: true }); await page.screenshot({ path: resolve('artifacts/tools-failure.png') }); } }
    throw error;
  } finally { if (app) await app.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
