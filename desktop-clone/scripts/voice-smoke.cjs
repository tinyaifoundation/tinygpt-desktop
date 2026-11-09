// Isolated desktop acceptance: fixture providers, silent PCM playback, no user accounts.
const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { mkdir, writeFile } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const assert = require('node:assert/strict');
const delay = ms => new Promise(done => setTimeout(done, ms));
async function main() {
  const profile = resolve('.tools-smoke-profile', `voice-${Date.now()}`), folder = join(profile, 'project'); await mkdir(folder, { recursive: true }); await writeFile(join(folder, 'evidence.txt'), 'PRIVATE TOOL OUTPUT. Do not read this aloud.');
  const speech = [], errors = []; let calls = 0, app, page;
  const samples = Buffer.alloc(24000 * 2 * 4); for (let index = 0; index < samples.length / 2; index++) samples.writeInt16LE(Math.round(Math.sin(index / 24000 * Math.PI * 2 * 220) * 500), index * 2);
  const wav = Buffer.alloc(44); wav.write('RIFF'); wav.writeUInt32LE(samples.length + 36, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples.length, 40);
  const models = [{ id: 'fixture-chat', name: 'Fixture Chat', architecture: { input_modalities: ['text'], output_modalities: ['text'] }, context_length: 32768, supported_parameters: ['tools'], tools: true }, { id: 'gpt-4o-mini-tts', name: 'Fixture Speech', architecture: { input_modalities: ['text'], output_modalities: ['speech'] }, supported_voices: ['coral', 'cedar'] }, { id: 'fixture-image', name: 'Fixture Image', output_modalities: ['image'] }];
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: models })); return; }
    let raw = ''; for await (const chunk of request) raw += chunk; const input = JSON.parse(raw);
    if (request.url.endsWith('/audio/speech')) { speech.push(input); await delay(500); response.writeHead(200, { 'Content-Type': 'audio/wav' }).end(Buffer.concat([wav, samples])); return; }
    const step = calls++, id = `voice-chat-${step}`;
    const event = (delta, finish) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'fixture-chat', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const delta = step === 0 ? { role: 'assistant', reasoning_content: 'PRIVATE REASONING', content: 'PRE-TOOL COMMENTARY', tool_calls: [{ index: 0, id: 'voice-read', type: 'function', function: { name: 'read_project_file', arguments: JSON.stringify({ path: 'evidence.txt' }) } }] } : { role: 'assistant', content: '**This is the final answer.**' };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(event(delta, null) + event({}, step === 0 ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
  }); await new Promise(done => server.listen(0, '127.0.0.1', done));
  try {
    const env = { ...process.env, TINYGPT_TOOLS_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/tools-smoke-main.cjs')], env }); page = await app.firstWindow(); page.setDefaultTimeout(25000); page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow, dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); for (const window of BrowserWindow.getAllWindows()) { window.setPosition(-10000, -10000); window.setIgnoreMouseEvents(true); window.webContents.setBackgroundThrottling(false); window.webContents.setAudioMuted(true); window.showInactive(); } }, folder);
    await page.getByRole('button', { name: 'New chat', exact: true }).waitFor();
    const ids = await page.evaluate(async endpoint => {
      const bridge = window.tinygpt, configured = await bridge.connectWithKey({ provider: 'custom', protocol: 'openai-compatible', endpoint, key: 'fixture-key' }); if (!configured.ok) throw Error(configured.error);
      const connection = configured.value.inferenceConnections.at(-1), chosen = await bridge.chooseConnectionModel(connection.id, 'fixture-chat'); if (!chosen.ok) throw Error(chosen.error);
      const result = await bridge.saveSettings({ ...chosen.value.settings, mode: 'chat', byok: { ...chosen.value.settings.byok, tools: true }, toolPermissions: { ...chosen.value.settings.toolPermissions, read: 'allow' } }); if (!result.ok) throw Error(result.error);
      const folder = await bridge.chooseNewProjectFolder(), project = await bridge.createProject('Voice fixture', '', false, folder.value.id); if (!project.ok) throw Error(project.error);
      const chat = await bridge.createConversation(project.value.id); if (!chat.ok) throw Error(chat.error); return { chatId: chat.value.id, connectionId: connection.id };
    }, `http://127.0.0.1:${server.address().port}/v1`);
    await page.reload(); await page.getByRole('button', { name: 'Settings', exact: true }).click(); const nav = page.getByRole('navigation', { name: 'Settings sections' });
    const labels = await nav.getByRole('button').allTextContents(); assert.deepEqual(labels.slice(-3), ['Keyboard shortcuts', 'Archived chats', 'Diagnostics']); assert.ok(!labels.includes('Import')); assert.ok(!labels.includes('Computer history'));
    await nav.getByRole('button', { name: 'Image/Video', exact: true }).click(); assert.equal(await page.getByText('Image requests follow your OpenRouter account privacy settings.', { exact: true }).count(), 0);
    await nav.getByRole('button', { name: 'Voice', exact: true }).click(); await page.getByRole('button', { name: 'Read aloud speech model', exact: true }).waitFor(); await page.waitForFunction(() => !document.querySelector('[aria-label="Read aloud speech model"]').disabled);
    await page.getByRole('button', { name: 'Transcription language', exact: true }).click(); await page.getByRole('menuitemradio', { name: 'German', exact: true }).click();
    await page.getByRole('switch', { name: 'Automatic transcription punctuation', exact: true }).click();
    await page.getByRole('button', { name: 'Transcription pause', exact: true }).click(); await page.getByRole('menuitemradio', { name: '1.2 seconds', exact: true }).click();
    await page.getByRole('button', { name: 'Read aloud speech model', exact: true }).click(); await page.getByRole('menuitemradio').filter({ hasText: 'Fixture Speech' }).click(); await page.getByRole('button', { name: 'Read aloud voice', exact: true }).click(); await page.getByRole('menuitemradio', { name: 'cedar', exact: true }).click();
    await page.getByRole('button', { name: 'Read aloud speed', exact: true }).click(); await page.getByRole('menuitemradio', { name: '1.25×', exact: true }).click();
    const settings = (await page.evaluate(() => window.tinygpt.snapshot())).value.settings; assert.equal(settings.voice.readAloud.enabled, false); assert.equal(settings.byok.model, 'fixture-chat'); assert.equal(settings.voice.dictation.language, 'de-DE'); assert.equal(settings.voice.dictation.pauseMs, 1200); assert.equal(settings.voice.dictation.automaticPunctuation, false); assert.equal(settings.voice.readAloud.selection.connectionId, ids.connectionId);
    await page.screenshot({ path: resolve('artifacts/voice-settings.png') }); await page.getByRole('button', { name: 'Preview voice', exact: true }).click(); await page.getByRole('button', { name: 'Stop preview', exact: true }).waitFor(); await page.waitForFunction(() => !!document.querySelector('[aria-label="Read aloud speed"]') && document.querySelectorAll('audio').length === 0); await page.getByRole('button', { name: 'Stop preview', exact: true }).click();
    assert.equal(speech[0].input, 'This is TinyGPT’s read aloud voice.'); assert.equal(speech[0].voice, 'cedar');
    await page.getByRole('switch', { name: 'Enable read aloud', exact: true }).click(); await page.getByRole('button', { name: 'Back to TinyGPT', exact: true }).click(); await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Read the evidence and return a final answer.'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByRole('button', { name: 'Read aloud', exact: true }).waitFor(); const chat = (await page.evaluate(id => window.tinygpt.conversation(id), ids.chatId)).value; assert.equal(chat.messages.at(-1).status, 'complete'); assert.ok(chat.tools.some(tool => tool.name === 'read_project_file' && tool.status === 'success'), JSON.stringify(chat.tools));
    await page.getByRole('button', { name: 'Read aloud', exact: true }).click(); await page.getByRole('button', { name: 'Pause read aloud', exact: true }).waitFor(); assert.equal(speech.at(-1).input, 'This is the final answer.'); assert.ok(!JSON.stringify(speech).includes('PRIVATE')); assert.ok(!JSON.stringify(speech).includes('COMMENTARY'));
    await page.getByRole('button', { name: 'Pause read aloud', exact: true }).click(); await page.getByRole('button', { name: 'Resume read aloud', exact: true }).click(); await page.getByRole('button', { name: 'Pause read aloud', exact: true }).waitFor(); await page.getByRole('button', { name: 'Stop read aloud', exact: true }).click(); await page.getByRole('button', { name: 'Read aloud', exact: true }).waitFor();
    await page.screenshot({ path: resolve('artifacts/read-aloud-response.png') });
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); await nav.getByRole('button', { name: 'Voice', exact: true }).click(); await page.getByRole('switch', { name: 'Enable read aloud', exact: true }).click(); await page.getByRole('switch', { name: 'Enable bundled transcription', exact: true }).click(); await page.getByRole('button', { name: 'Back to TinyGPT', exact: true }).click(); assert.equal(await page.getByRole('button', { name: 'Read aloud', exact: true }).count(), 0); assert.equal(await page.getByRole('button', { name: 'Dictate message', exact: true }).count(), 0);
    await page.reload(); const restored = (await page.evaluate(() => window.tinygpt.snapshot())).value.settings; assert.equal(restored.voice.dictation.enabled, false); assert.equal(restored.voice.readAloud.voice, 'cedar'); assert.equal(restored.voice.readAloud.speed, 1.25);
    const icon = await app.evaluate(({ nativeImage }, path) => { const image = nativeImage.createFromPath(path); return { empty: image.isEmpty(), size: image.getSize() }; }, resolve('src/main/assets/tinygpt.ico')); assert.equal(icon.empty, false); assert.ok(icon.size.width >= 16);
    assert.deepEqual(errors, []); console.log(JSON.stringify({ checks: ['settings navigation order and removed tabs', 'image privacy footer removed', 'bundled transcription controls persist', 'eligible configured speech models and model-specific voices', 'voice preview', 'final answer only', 'silent native audio playback', 'pause/resume/stop', 'read aloud and microphone controls honor enable switches', 'restart persistence', 'Windows icon decodes'], speechRequests: speech.length, providerRequests: calls, errors }));
  } catch (error) { if (page) { await page.screenshot({ path: resolve('artifacts/voice-failure.png') }).catch(() => {}); console.log((await page.locator('body').innerText()).slice(-4000)); } throw error; }
  finally { if (app) await app.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
