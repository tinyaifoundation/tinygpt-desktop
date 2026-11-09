const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { resolve, join } = require('node:path');
const { mkdir, readFile, access } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
async function poll(read, timeout = 60000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await read()) return; await new Promise(done => setTimeout(done, 100)); }
  throw Error('The Bot check did not reach its expected saved state.');
}
async function main() {
  const profile = process.env.TINYGPT_BOT_PROOF_RESUME_PROFILE ? resolve(process.env.TINYGPT_BOT_PROOF_RESUME_PROFILE) : resolve('.tools-smoke-profile', `bot-connected-${Date.now()}`), folder = join(profile, 'project');
  await mkdir(folder, { recursive: true }); await mkdir(resolve('artifacts'), { recursive: true });
  const calls = [], slowResponses = new Set();
  const server = createServer(async (request, response) => {
    if (request.url === '/article') { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Bot research</title><main id="proof"></main><script>document.getElementById("proof").textContent="BOT_BROWSER_RENDERED: The report was verified in Chromium."</script>'); return; }
    if (request.method === 'GET') { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'bot-fixture' }] })); return; }
    let raw = ''; for await (const chunk of request) raw += chunk; const body = JSON.parse(raw); calls.push(body);
    assert.equal(request.headers.authorization, 'Bearer tinygpt-local'); assert.equal(body.model, 'bot-fixture');
    const messages = body.messages ?? [];
    const latest = messages.filter(message => message.role === 'user' && typeof message.content === 'string' && /PROOF|NATIVE_EXEC/.test(message.content)).at(-1)?.content?.split('Current user message:\n').at(-1) ?? '';
    const native = body.tools?.some(tool => tool.function?.name === 'tinygpt_action');
    if (process.env.TINYGPT_BOT_PROOF_DEBUG === '1') console.log('Fixture request:', { tools: body.tools?.map(tool => tool.function?.name), native });
    if (native) { for (const name of ['tinygpt_action', 'read', 'write', 'exec']) assert.ok(body.tools.some(tool => tool.function.name === name), `Missing native tool: ${name}`); }
    const toolResult = messages.filter(message => message.role === 'tool').at(-1); const result = !!toolResult;
    if (result && process.env.TINYGPT_BOT_PROOF_DEBUG === '1') console.log('Fixture action outcome:', toolResult.content);
    const id = randomUUID(); const frame = (delta, finish = null) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'bot-fixture', choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } } : {}) })}\n\n`;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (native && !result && latest.includes('NATIVE_MESSAGES_PROOF')) {
      assert.ok(body.tools.some(tool => tool.function.name === 'message'), 'Missing native message tool');
      response.end(frame({ role: 'assistant', tool_calls: ['First native message.', 'Second native message.'].map((message, index) => ({ index, id: randomUUID(), type: 'function', function: { name: 'message', arguments: JSON.stringify({ action: 'send', message }) } })) }) + frame({}, 'tool_calls') + 'data: [DONE]\n\n'); return;
    }
    if (native && result && latest.includes('NATIVE_MESSAGES_PROOF')) { response.end(frame({ role: 'assistant', content: 'NO_REPLY' }) + frame({}, 'stop') + 'data: [DONE]\n\n'); return; }
    if (native && !result && /NATIVE_FILE_PROOF|NATIVE_EXEC_ALLOW|NATIVE_EXEC_DENY/.test(latest)) {
      const name = latest.includes('NATIVE_FILE_PROOF') ? 'write' : 'exec';
      const args = name === 'write' ? { path: 'native-report.txt', content: 'OPENCLAW_NATIVE_FILE' } : { command: `"${resolve('runtimes/openclaw/node/node.exe')}" -e "${latest.includes('DENY') ? "require('node:fs').writeFileSync('native-denied.txt','SHOULD_NOT_RUN')" : "console.log('OPENCLAW_NATIVE_COMMAND')"}"`, yieldMs: 1000 };
      response.end(frame({ role: 'assistant', ...(name === 'write' ? { content: 'I’ll save that now.' } : {}), tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }) + frame({}, 'tool_calls') + 'data: [DONE]\n\n'); return;
    }
    if (native && !result && latest.includes('BROWSER_PROOF')) {
      response.end(frame({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: 'tinygpt_action', arguments: JSON.stringify({ name: 'read_page', input: { url: `http://127.0.0.1:${server.address().port}/article`, status: 'Checking the research page', permission: 'May I read the research page?' } }) } }] }) + frame({}, 'tool_calls') + 'data: [DONE]\n\n'); return;
    }
    if (native && !result && /FILE_PROOF|DENY_PROOF|APPROVAL_STOP|LIMIT_PROOF/.test(latest)) {
      const filename = latest.includes('DENY_PROOF') ? 'denied.md' : latest.includes('APPROVAL_STOP') ? 'stopped.md' : latest.includes('LIMIT_PROOF') ? 'truncated.md' : 'report.md';
      response.end(frame({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: 'tinygpt_action', arguments: JSON.stringify({ name: 'write_project_file', input: { path: filename, content: '# Bot report\nVerified through TinyGPT.', status: 'Saving the local report', permission: 'May I save the report?' } }) } }] }) + frame({}, latest.includes('LIMIT_PROOF') ? 'length' : 'tool_calls') + 'data: [DONE]\n\n'); return;
    }
    if (native && !result && latest.includes('SLOW_PROOF') && !messages.some(message => message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('Continue the interrupted answer'))) {
      response.write(frame({ role: 'assistant', content: 'A partial bot reply.' })); slowResponses.add(response);
      const timer = setInterval(() => response.write(': keepalive\n\n'), 1000); response.on('close', () => { slowResponses.delete(response); clearInterval(timer); }); return;
    }
    if (native && !result && latest.includes('REACTION_PROOF')) {
      const policy = messages.find(message => message.role === 'system' && message.content.includes('optional emoji reactions:'))?.content ?? '';
      const ids = JSON.parse(policy.match(/optional emoji reactions: (\[.*\])/)[1]);
      response.end(frame({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: 'tinygpt_action', arguments: JSON.stringify({ name: 'react_to_message', input: { messageId: ids.at(-1).id, emoji: '🫶' } }) } }] }) + frame({}, 'tool_calls') + 'data: [DONE]\n\n'); return;
    }
    if (native && result && latest.includes('BROWSER_PROOF')) assert.match(toolResult.content, /BOT_BROWSER_RENDERED/);
    const text = native ? result ? latest.includes('BROWSER_PROOF') ? `BOT_BROWSER_FINISHED ${JSON.parse(toolResult.content).citation ?? ''}` : 'BOT_ACTION_FINISHED' : 'BOT_CONNECTED_REPLY' : 'CHAT_STILL_WORKS';
    response.end(frame({ role: 'assistant', content: text }) + frame({}, 'stop') + 'data: [DONE]\n\n');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: profile, TINYGPT_BOT_PROOF_DEBUG: '1' }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  let desktop, stderr = '', botId; const errors = [];
  async function launch() {
    desktop = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: ['--force-device-scale-factor=1', resolve('scripts/bot-conversation-smoke-main.cjs')], env });
    desktop.process().stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000); });
    const page = await desktop.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message)); return page;
  }
  try {
    let page = await launch();
    if (!process.env.TINYGPT_BOT_PROOF_RESUME_PROFILE) {
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    await page.evaluate(async endpoint => { const snapshot = (await window.tinygpt.snapshot()).value; const result = await window.tinygpt.saveSettings({ ...snapshot.settings, route: 'local', local: { ...snapshot.settings.local, model: 'bot-fixture', tools: true, contextWindowTokens: 64000, endpoint } }); if (!result.ok) throw Error(result.error); }, `http://127.0.0.1:${server.address().port}/v1`);
    await desktop.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, folder);
    const projectId = await page.evaluate(async () => { const result = await window.tinygpt.createProject('Bot project', 'Save reports here.'); if (!result.ok) throw Error(result.error); const folder = await window.tinygpt.chooseProjectFolder(result.value.id); if (!folder.ok) throw Error(folder.error); return result.value.id; });
    await page.reload(); await page.getByRole('button', { name: 'Your Bot', exact: true }).click(); await page.waitForTimeout(550);
    const setupMetrics = () => page.evaluate(() => {
      const rect = selector => { const element = document.querySelector(selector); const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height }; };
      return { heading: rect('.bot-introduction h1'), avatar: rect('.bot-preview-stage [data-robot-avatar]'), controls: rect('.bot-design-controls'), button: rect('.bot-designer-next button:last-child'), font: getComputedStyle(document.querySelector('.bot-introduction h1')).fontSize };
    });
    const appearanceMetrics = await setupMetrics();
    await page.evaluate(() => { window.setupAvatar = document.querySelector('.bot-preview-stage [data-robot-avatar]'); });
    await page.screenshot({ path: resolve('artifacts/bot-setup-appearance-stable.png') });
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('heading', { name: "Let's get Your Bot ready.", exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.bot-designer').getAnimations({ subtree: true }).some(animation => animation.effect.target.matches('.bot-introduction, .bot-design-controls, .bot-designer-next')));
    const connectionMetrics = await setupMetrics();
    assert.equal(await page.evaluate(() => window.setupAvatar === document.querySelector('.bot-preview-stage [data-robot-avatar]')), true);
    for (const part of ['heading', 'avatar', 'controls']) for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(appearanceMetrics[part][key] - connectionMetrics[part][key]) < 1, `${part}.${key} moved between steps: ${JSON.stringify({ appearanceMetrics, connectionMetrics })}`);
    assert.equal(appearanceMetrics.font, connectionMetrics.font);
    assert.ok(Math.abs(appearanceMetrics.button.y - connectionMetrics.button.y) < 1);
    assert.ok(Math.abs(appearanceMetrics.button.x + appearanceMetrics.button.width - connectionMetrics.button.x - connectionMetrics.button.width) < 1);
    await page.getByRole('button', { name: 'Go back', exact: true }).click(); await page.getByRole('heading', { name: 'Introducing Your Bot', exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.bot-designer').getAnimations({ subtree: true }).some(animation => animation.effect.target.matches('.bot-introduction, .bot-design-controls, .bot-designer-next')));
    assert.equal(await page.evaluate(() => window.setupAvatar === document.querySelector('.bot-preview-stage [data-robot-avatar]')), true);
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    assert.equal(await page.getByRole('region', { name: 'Bot setup', exact: true }).getByRole('button', { name: 'Bot project', exact: true }).count(), 0); await page.evaluate(async projectId => { const value = (await window.tinygpt.botSnapshot()).value; const result = await window.tinygpt.prepareBot({ name: 'Your Bot', projectId }); if (!result.ok) throw Error(result.error); }, projectId);
    await page.waitForTimeout(550); await page.screenshot({ path: resolve('artifacts/bot-setup-connected.png') });
    await page.evaluate(async projectId => { const result = await window.tinygpt.completeBot({ name: 'Your Bot', projectId }); if (!result.ok) throw Error(result.error); }, projectId); await page.reload();
    await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor({ timeout: 180000 });
    const botMenu = page.getByRole('button', { name: 'More for Your Bot', exact: true });
    await page.getByRole('button', { name: 'Your Bot', exact: true }).hover(); await botMenu.click();
    await page.getByRole('menuitem', { name: 'Customize', exact: true }).click();
    await page.getByRole('region', { name: 'Bot personalization' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Next', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Edit bot name', exact: true }).click();
    await page.getByRole('textbox', { name: 'Bot name', exact: true }).fill('Cancel this name');
    await page.getByRole('textbox', { name: 'Bot name', exact: true }).press('Enter');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.locator('.bot-name-pill').waitFor(); assert.equal(await page.locator('.bot-name-pill').innerText(), 'Your Bot');
    assert.equal(await page.locator('.bot-name-pill svg').count(), 0);
    await page.locator('.bot-name-pill').click(); await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('.bot-name-pill').waitFor();
    await page.getByRole('button', { name: 'Your Bot', exact: true }).hover(); await botMenu.click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Back to TinyGPT', exact: true }).click();
    await page.locator('.bot-name-pill').waitFor();
    botId = await page.evaluate(async () => (await window.tinygpt.botSnapshot()).value.conversationId);
    assert.equal((await page.evaluate(async () => (await window.tinygpt.conversation((await window.tinygpt.botSnapshot()).value.conversationId)).value)).mode, 'bot');
    assert.equal((await page.evaluate(async () => (await window.tinygpt.conversation((await window.tinygpt.botSnapshot()).value.conversationId)).value)).projectId, projectId);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Hello BOT_PROOF'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByText('BOT_CONNECTED_REPLY', { exact: true }).waitFor({ timeout: 60000 });
    // Observe every DOM mutation, including setup mounts too brief for a screenshot.
    await page.evaluate(() => {
      window.botSetupFlashes = 0;
      window.botSwitchObserver = new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) if (node instanceof Element && (node.matches('.bot-designer') || node.querySelector('.bot-designer'))) window.botSetupFlashes++;
      });
      window.botSwitchObserver.observe(document.body, { childList: true, subtree: true });
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.getByRole('button', { name: 'New chat', exact: true }).click();
      await page.locator('.conversation-pane[data-mode="chat"]').waitFor();
      await page.getByRole('button', { name: 'Your Bot', exact: true }).click();
      await page.locator('.bot-conversation-header').waitFor();
      await page.getByText('BOT_CONNECTED_REPLY', { exact: true }).waitFor();
    }
    assert.equal(await page.evaluate(() => { window.botSwitchObserver.disconnect(); return window.botSetupFlashes; }), 0, 'Opening a configured bot must never mount onboarding');
    console.log('Bot navigation proof passed: zero onboarding mounts during three sidebar switches.');
    await page.screenshot({ path: resolve('artifacts/bot-conversation-light.png') });
    const bubble = await page.locator('[data-mode="bot"] [data-slot="answer-text"]').first().evaluate(element => ({ background: getComputedStyle(element).backgroundColor, radius: getComputedStyle(element).borderBottomLeftRadius })); assert.notEqual(bubble.background, 'rgba(0, 0, 0, 0)'); assert.equal(bubble.radius, '6px');
    assert.equal(await page.locator('.bot-conversation-header [data-robot-avatar]').count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Retry reply', exact: true }).count(), 0);
    const alignedHeader = async () => {
      const edges = await page.evaluate(() => { const avatar = document.querySelector('.bot-conversation-header [data-robot-avatar]').getBoundingClientRect(); const pill = document.querySelector('.bot-name-pill').getBoundingClientRect(); const pane = document.querySelector('.conversation-pane').getBoundingClientRect(); return { avatar: avatar.left + avatar.width / 2, pill: pill.left + pill.width / 2, center: pane.left + pane.width / 2 }; });
      assert.ok(Math.abs(edges.avatar - edges.center) < 2 && Math.abs(edges.pill - edges.center) < 2, 'Bot avatar and name pill must be centered');
    };
    await alignedHeader();
    assert.equal(await page.getByRole('button', { name: 'Edit message', exact: true }).count(), 0);
    assert.equal(await page.locator('[data-slot="answer-actions"]').count(), 0);
    const firstReply = page.locator('.bot-message-incoming').first(); await firstReply.hover();
    await firstReply.getByRole('button', { name: 'React to message', exact: true }).click();
    await page.getByRole('button', { name: 'React ❤️', exact: true }).click();
    await firstReply.getByRole('button', { name: 'Your reaction ❤️', exact: true }).waitFor();
    await page.reload(); await page.getByRole('button', { name: 'Your reaction ❤️', exact: true }).waitFor();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('REACTION_PROOF'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByRole('button', { name: 'Bot reacted 🫶', exact: true }).waitFor({ timeout: 60000 });
    await poll(() => page.evaluate(async id => !(await window.tinygpt.library()).value.activeRuns.some(run => run.conversationId === id), botId));
    await page.screenshot({ path: resolve('artifacts/bot-texting-light.png') });
    const popped = desktop.waitForEvent('window');
    const opening = await page.evaluate(async id => window.tinygpt.popOutChat(id), botId); assert.equal(opening.ok, true);
    const popoutPage = await popped; popoutPage.on('pageerror', error => errors.push(error.message));
    await popoutPage.locator('.bot-conversation-header.is-compact').waitFor();
    assert.equal(await popoutPage.getByRole('button', { name: 'Edit message', exact: true }).count(), 0);
    assert.equal(await popoutPage.locator('[data-slot="answer-actions"]').count(), 0);
    await popoutPage.screenshot({ path: resolve('artifacts/bot-texting-popout.png') });
    await popoutPage.evaluate(async () => { const result = await window.tinygpt.returnChat(); if (!result.ok) throw Error(result.error); });
    await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
    console.log('Texting proof passed: centered header, no response controls, human reaction survives reload, native Bot reaction is delivered.');
    const workspace = join(profile, 'bot-runtime', botId, 'workspace');
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('NATIVE_MESSAGES_PROOF'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await poll(() => page.evaluate(async id => !(await window.tinygpt.library()).value.activeRuns.some(run => run.conversationId === id), botId));
    const delivered = await page.evaluate(async id => (await window.tinygpt.conversation(id)).value, botId);
    assert.deepEqual(delivered.messages.filter(message => message.runId === delivered.messages.at(-1).runId).map(message => message.text), ['First native message.', 'Second native message.']);
    assert.equal(await page.getByText('NO_REPLY', { exact: true }).count(), 0);
    assert.equal(await page.locator('.tool-chain').count(), 0);
    const nativeConfig = JSON.parse(await readFile(join(profile, 'bot-runtime', botId, 'openclaw.json'), 'utf8'));
    assert.equal(nativeConfig.agents.entries.main.identity.name, 'Your Bot');
    assert.match(await readFile(join(workspace, 'IDENTITY.md'), 'utf8'), /Name:\*\* Your Bot/);
    for (const marker of ['NATIVE_FILE_PROOF', 'NATIVE_EXEC_ALLOW', 'NATIVE_EXEC_DENY']) {
      await page.getByRole('textbox', { name: 'Message', exact: true }).fill(marker); await page.getByRole('button', { name: 'Send message', exact: true }).click();
      if (marker.includes('EXEC')) { const approval = page.getByRole('region', { name: 'Tool approval', exact: true }); await approval.waitFor({ timeout: 60000 }); await approval.getByRole('button', { name: marker.includes('DENY') ? /^Deny/ : /^Allow once/ }).click(); await approval.waitFor({ state: 'hidden', timeout: 20000 }); }
      await poll(() => page.evaluate(async id => !(await window.tinygpt.library()).value.activeRuns.some(run => run.conversationId === id), botId));
      const details = await page.evaluate(async id => (await window.tinygpt.conversation(id)).value, botId);
      assert.equal(details.messages.at(-1).status, 'complete', JSON.stringify(details.messages.at(-1)));
      assert.ok(details.tools.some(tool => tool.name === (marker.includes('FILE') ? 'bot_write' : 'bot_exec')), 'Native activity was not recorded');
      if (marker.includes('FILE')) {
        const replies = details.messages.filter(message => message.runId === details.messages.at(-1).runId);
        assert.deepEqual(replies.map(message => message.text), ['I’ll save that now.', 'BOT_ACTION_FINISHED']);
        assert.ok(replies.every(message => message.status === 'complete'));
      }
      assert.equal(await page.locator('.tool-chain').count(), 0, 'Bot mode must hide the toolchain');
    }
    assert.equal(await readFile(join(workspace, 'native-report.txt'), 'utf8'), 'OPENCLAW_NATIVE_FILE');
    assert.equal(await access(join(workspace, 'native-denied.txt')).then(() => true, () => false), false);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('FILE_PROOF'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByRole('button', { name: 'Allow once', exact: true }).waitFor({ timeout: 60000 }); assert.equal(await access(join(folder, 'report.md')).then(() => true, () => false), false);
    assert.equal(await page.locator('.bot-conversation-header [data-robot-avatar]').getAttribute('data-action'), 'blocked');
    await page.getByRole('button', { name: 'Allow once', exact: true }).click(); await poll(() => page.evaluate(async id => !(await window.tinygpt.library()).value.activeRuns.some(run => run.conversationId === id), botId)); assert.match(await readFile(join(folder, 'report.md'), 'utf8'), /Verified through TinyGPT/);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('BROWSER_PROOF'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByRole('button', { name: 'Allow once', exact: true }).waitFor({ timeout: 60000 }); await page.getByRole('button', { name: 'Allow once', exact: true }).click();
    await page.getByText(/BOT_BROWSER_FINISHED/).waitFor({ timeout: 60000 });
    const researched = await page.evaluate(async () => (await window.tinygpt.conversation((await window.tinygpt.botSnapshot()).value.conversationId)).value);
    assert.match(researched.tools.at(-1).result, /BOT_BROWSER_RENDERED/); assert.equal(researched.tools.at(-1).status, 'success'); assert.equal(researched.sources.some(source => source.title === 'Bot research'), true);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('DENY_PROOF'); await page.getByRole('button', { name: 'Send message', exact: true }).click(); await page.getByRole('button', { name: /^Deny/ }).waitFor({ timeout: 60000 }); await page.getByRole('button', { name: /^Deny/ }).click();
    await page.getByRole('button', { name: 'Send message', exact: true }).waitFor({ timeout: 60000 }); assert.equal(await access(join(folder, 'denied.md')).then(() => true, () => false), false);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('APPROVAL_STOP'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByRole('button', { name: 'Allow once', exact: true }).waitFor({ timeout: 60000 });
    await page.getByRole('button', { name: 'Stop reply', exact: true }).click(); await page.getByRole('button', { name: 'Send message', exact: true }).waitFor();
    assert.equal(await access(join(folder, 'stopped.md')).then(() => true, () => false), false);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('LIMIT_PROOF'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await poll(() => page.evaluate(async () => (await window.tinygpt.conversation((await window.tinygpt.botSnapshot()).value.conversationId)).value.messages.at(-1).status !== 'streaming'));
    const limited = await page.evaluate(async () => (await window.tinygpt.conversation((await window.tinygpt.botSnapshot()).value.conversationId)).value.messages.at(-1));
    assert.equal(limited.status, 'interrupted'); assert.match(limited.error, /output limit/); assert.equal(await access(join(folder, 'truncated.md')).then(() => true, () => false), false);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('SLOW_PROOF'); await page.getByRole('button', { name: 'Send message', exact: true }).click(); await poll(() => slowResponses.size === 1);
    await page.getByRole('status', { name: 'Bot is typing', exact: true }).waitFor(); assert.equal(await page.getByText('A partial bot reply.', { exact: true }).count(), 0);
    const liveAvatar = page.locator('.bot-conversation-header [data-robot-avatar]');
    await poll(async () => await liveAvatar.getAttribute('data-activity') === 'writing');
    assert.equal(await liveAvatar.getAttribute('data-action'), 'input');
    assert.match(await liveAvatar.getAttribute('data-animation'),/thinking/);
    await page.evaluate(() => { document.documentElement.dataset.motion = 'reduce'; window.dispatchEvent(new Event('tinygpt-motion')); });
    await page.waitForTimeout(4800); assert.equal(await liveAvatar.getAttribute('data-action'), 'input');
    await page.evaluate(() => { document.documentElement.dataset.motion = 'full'; window.dispatchEvent(new Event('tinygpt-motion')); });
    await page.getByRole('button', { name: 'New chat', exact: true }).click(); await page.getByRole('textbox', { name: 'Message', exact: true }).fill('CHAT_PROOF'); await page.getByRole('button', { name: 'Send message', exact: true }).click(); await page.getByText('CHAT_STILL_WORKS', { exact: true }).waitFor({ timeout: 60000 });
    assert.equal(slowResponses.size, 1); await page.getByRole('button', { name: 'Your Bot', exact: true }).click(); await page.getByRole('button', { name: 'Stop reply', exact: true }).click();
    await page.getByRole('button', { name: 'Send message', exact: true }).waitFor(); await poll(() => page.evaluate(async () => !(await window.tinygpt.library()).value.activeRuns.length));
    assert.equal(slowResponses.size, 0);
    assert.equal(await liveAvatar.getAttribute('data-activity'), null);
    await page.evaluate(() => { const prefs = JSON.parse(localStorage.getItem('tinygpt-appearance-v4')); prefs.theme = 'dark'; localStorage.setItem('tinygpt-appearance-v4', JSON.stringify(prefs)); });
    await page.reload(); await page.locator('.bot-conversation-header').waitFor(); await page.screenshot({ path: resolve('artifacts/bot-conversation-dark.png') });
    await desktop.evaluate(({ BrowserWindow }, url) => { const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === url); if (!window) throw Error('The main fixture window is unavailable.'); window.setSize(850, 600); }, page.url()); await page.waitForFunction(() => innerWidth === 850 && innerHeight === 600); await page.screenshot({ path: resolve('artifacts/bot-conversation-narrow.png') }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); await alignedHeader();
    await desktop.close(); desktop = null;
    page = await launch(); await page.locator('.bot-conversation-header').waitFor();
    const saved = await page.evaluate(async () => (await window.tinygpt.conversation((await window.tinygpt.botSnapshot()).value.conversationId)).value);
    assert.equal(saved.messages.some(message => message.text === 'BOT_CONNECTED_REPLY'), true); assert.equal(await page.getByText('A partial bot reply.', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Next', exact: true }).count(), 0); assert.equal(await page.evaluate(async () => (await window.tinygpt.botSnapshot()).value.conversationId), botId);
    await poll(() => page.evaluate(async () => (await window.tinygpt.botSnapshot()).value.phase === 'ready'), 180000);
    const resumed = await page.evaluate(async () => { const id = (await window.tinygpt.botSnapshot()).value.conversationId; const saved = (await window.tinygpt.conversation(id)).value; const blocked = await window.tinygpt.continueMessage(id, saved.messages.at(-1).id); if (blocked.ok) throw Error('Bot continuation must require a new text message'); return window.tinygpt.sendMessage(id, 'Please finish the interrupted reply.', []); }); assert.equal(resumed.ok, true);
    await poll(() => page.evaluate(async () => (await window.tinygpt.conversation((await window.tinygpt.botSnapshot()).value.conversationId)).value.messages.at(-1).status !== 'streaming'));
    const restored = await page.evaluate(async () => (await window.tinygpt.conversation((await window.tinygpt.botSnapshot()).value.conversationId)).value);
    assert.equal(restored.messages.at(-1).status, 'complete'); assert.match(restored.messages.at(-1).text, /BOT_CONNECTED_REPLY/);
    assert.equal(restored.tools.filter(tool => tool.name === 'write_project_file' && tool.status === 'success').length, 1); assert.match(await readFile(join(folder, 'report.md'), 'utf8'), /Verified through TinyGPT/);
    assert.match(JSON.stringify(calls.at(-1)), /Recorded tool outcomes/); assert.match(JSON.stringify(calls.at(-1)), /denied/);
    } else {
      await page.evaluate(async endpoint => { const snapshot = (await window.tinygpt.snapshot()).value; const result = await window.tinygpt.saveSettings({ ...snapshot.settings, mode: 'bot', route: 'local', local: { ...snapshot.settings.local, model: 'bot-fixture', tools: true, endpoint } }); if (!result.ok) throw Error(result.error); }, 'http://127.0.0.1:' + server.address().port + '/v1');
      await page.reload(); await page.locator('.bot-name-pill').waitFor(); botId = await page.evaluate(async () => (await window.tinygpt.botSnapshot()).value.conversationId);
      const seeded = await page.evaluate(async id => window.tinygpt.sendMessage(id, 'OLD_RESET_PROOF ' + 'A previous conversation message. '.repeat(80), []), botId); assert.equal(seeded.ok, true);
      await poll(() => page.evaluate(async id => (await window.tinygpt.conversation(id)).value.messages.at(-1).status === 'complete', botId));
    }
    const overlay = await page.evaluate(() => {
      const header = document.querySelector('.bot-conversation-header'); const viewport = document.querySelector('.thread-viewport');
      const before = header.getBoundingClientRect().top; viewport.scrollTop = Math.max(160, viewport.scrollHeight - viewport.clientHeight);
      return { before, after: header.getBoundingClientRect().top, scroll: viewport.scrollTop, background: getComputedStyle(header).backgroundColor, position: getComputedStyle(header).position, viewportTop: viewport.getBoundingClientRect().top, headerTop: header.getBoundingClientRect().top };
    });
    assert.equal(overlay.position, 'absolute'); assert.equal(overlay.background, 'rgba(0, 0, 0, 0)'); assert.equal(overlay.before, overlay.after); assert.ok(overlay.scroll > 0); assert.ok(overlay.viewportTop < overlay.headerTop);
    await page.screenshot({ path: resolve('artifacts/bot-menu-transparent-header.png') });
    const note = await page.evaluate(async () => window.tinygpt.saveBotNote({ file: 'MEMORY.md', text: 'KEEP_BOT_MEMORY' })); assert.equal(note.ok, true);
    const nativeSessionsFile = join(profile, 'bot-runtime', botId, 'state', 'agents', 'main', 'agent', 'openclaw-agent.sqlite');
    function nativeSessions() { const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(nativeSessionsFile, { readOnly: true }); try { return Object.fromEntries(db.prepare('SELECT session_key AS key,current_session_id AS sessionId,entry_json AS entry FROM session_nodes').all().map(row => [row.key, { sessionId: row.sessionId, revision: JSON.parse(row.entry).lifecycleRevision }])); } finally { db.close(); } }
    const beforeReset = nativeSessions();
    const nativeKeys = Object.keys(beforeReset).filter(key => key.startsWith('agent:main:tinygpt-')); assert.ok(nativeKeys.length > 0);
    const popoutEvent = desktop.waitForEvent('window');
    await page.evaluate(async id => { const result = await window.tinygpt.popOutChat(id); if (!result.ok) throw Error(result.error); }, botId);
    const clearingPopout = await popoutEvent; await clearingPopout.locator('.bot-name-pill').waitFor();
    await clearingPopout.locator('.bot-name-pill').click(); await clearingPopout.getByRole('button', { name: 'Cancel', exact: true }).click(); await clearingPopout.locator('.bot-name-pill').waitFor();
    await clearingPopout.locator('.bot-name-pill').click(); await clearingPopout.getByRole('button', { name: 'Save', exact: true }).click(); await clearingPopout.locator('.bot-name-pill').waitFor(); assert.equal(clearingPopout.isClosed(), false);
    await page.getByRole('button', { name: 'Your Bot', exact: true }).hover(); await page.getByRole('button', { name: 'More for Your Bot', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Clear conversation', exact: true }).click();
    await page.getByRole('dialog', { name: 'Clear bot conversation?', exact: true }).getByRole('button', { name: 'Clear conversation', exact: true }).click();
    await page.getByRole('dialog', { name: 'Clear bot conversation?', exact: true }).waitFor({ state: 'hidden', timeout: 180000 });
    const afterReset = nativeSessions();
    for (const key of nativeKeys) assert.notEqual(afterReset[key]?.revision, beforeReset[key].revision);
    await poll(() => clearingPopout.locator('.bot-message').count().then(count => count === 0)); assert.equal(clearingPopout.isClosed(), false);
    await clearingPopout.evaluate(async () => { const result = await window.tinygpt.returnChat(); if (!result.ok) throw Error(result.error); });
    const cleared = await page.evaluate(async () => (await window.tinygpt.conversation((await window.tinygpt.botSnapshot()).value.conversationId)).value);
    assert.equal(cleared.id, botId); assert.deepEqual(cleared.messages, []); assert.deepEqual(cleared.tools, []);
    assert.equal((await page.evaluate(async () => window.tinygpt.botSnapshot())).value.configured, true);
    assert.match(await readFile(join(folder, 'report.md'), 'utf8'), /Verified through TinyGPT/);
    assert.match(await readFile(join(profile, 'bot-runtime', botId, 'workspace', 'MEMORY.md'), 'utf8'), /KEEP_BOT_MEMORY/);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('FRESH_PROOF'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await poll(async () => { const value = await page.evaluate(async () => (await window.tinygpt.conversation((await window.tinygpt.botSnapshot()).value.conversationId)).value); return value.messages.length === 2 && value.messages.at(-1).status === 'complete'; });
    const freshPrompt = calls.at(-1).messages.filter(message => message.role === 'user').map(message => message.content).join(' ');
    assert.match(freshPrompt, /FRESH_PROOF/); assert.doesNotMatch(freshPrompt, /NATIVE_FILE_PROOF|REACTION_PROOF|BROWSER_PROOF/);
    console.log('Bot menu proof passed: direct Save/Cancel, Settings navigation, transparent overlay header, real native session reset, preserved files and memory, and fresh next-turn context.');
    assert.deepEqual(errors, []); console.log('Connected Bot proof passed: setup/background preparation, real OpenClaw reply, bubble UI/avatar, Project write approval/denial, parallel Chat, scoped Stop, themes/narrow layout, and persisted setup/history after restart.');
  } catch (error) { if (desktop) { const page = await desktop.firstWindow(); await page.screenshot({ path: resolve('artifacts/bot-connected-failure.png') }).catch(() => {}); console.error('Fixture message order:', calls.slice(0, 6).map(call => (call.messages ?? []).filter(m => m.role !== 'system').map(m => ({ role:m.role, name:m.name, text:typeof m.content === 'string' ? m.content.slice(0,160) : m.content, calls:m.tool_calls?.map(c => c.function?.name) })))); console.error('Saved reply:', await page.evaluate(async () => { const bot=(await window.tinygpt.botSnapshot()).value; return bot.conversationId ? (await window.tinygpt.conversation(bot.conversationId)).value.messages.at(-1) : null; }).catch(() => null)); console.error('Bot status:', await page.evaluate(async () => window.tinygpt.botSnapshot()).catch(() => null)); } console.error('Fixture errors:', errors, stderr); throw error; }
  finally { if (desktop) await desktop.close(); for (const response of slowResponses) response.destroy(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
