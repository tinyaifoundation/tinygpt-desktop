const assert = require('node:assert/strict');
const { mkdir } = require('node:fs/promises');
const { resolve, join } = require('node:path');
const { tmpdir } = require('node:os');
const { createServer } = require('node:http');
const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');

(async () => {
  const profile = join(tmpdir(), `tinygpt-dictation-${Date.now()}`);
  await mkdir(profile, { recursive: true });
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  const chat = createServer(async (request, response) => {
    for await (const _chunk of request) {}
    if (request.method === 'GET') { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'dictation-fixture' }] })); return; }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'Fixture reply.' }, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => chat.listen(0, '127.0.0.1', resolve));
  const desktop = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [
    '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${resolve('artifacts/dictation-research/jfk.wav')}`, resolve('scripts/chat-window-smoke-main.cjs'),
  ], env });
  let page; const errors = [];
  try {
    page = await desktop.firstWindow(); page.setDefaultTimeout(30000); page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') console.error('Renderer:', message.text()); });
    await page.evaluate(() => window.tinygpt.onDictationEvent(event => console.log('Dictation event', JSON.stringify(event))));
    await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
    await page.evaluate(async endpoint => {
      const snapshot = (await window.tinygpt.snapshot()).value;
      const result = await window.tinygpt.saveSettings({ ...snapshot.settings, route: 'local', local: { ...snapshot.settings.local, model: 'dictation-fixture', endpoint } });
      if (!result.ok) throw Error(result.error);
    }, `http://127.0.0.1:${chat.address().port}/v1`);
    await page.getByRole('button', { name: 'Dictate message', exact: true }).waitFor();
    await page.getByRole('tab', { name: 'Work', exact: true }).click();
    await page.getByRole('button', { name: 'Dictate message', exact: true }).click();
    await page.locator('[data-slot="composer-voice"][data-recording]').waitFor();
    await page.screenshot({ path: resolve('artifacts/dictation-work.png') });
    await page.getByRole('button', { name: 'Stop dictation', exact: true }).click();
    await page.getByRole('button', { name: 'Dictate message', exact: true }).waitFor();
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Draft prefix');
    await page.getByRole('textbox', { name: 'Message', exact: true }).press('End');
    await page.getByRole('button', { name: 'Dictate message', exact: true }).click();
    await page.locator('[data-slot="composer-voice"][data-recording]').waitFor();
    await page.waitForFunction(() => document.querySelector('[aria-label="Message"]').value.length > 'Draft prefix'.length);
    const geometry = await page.evaluate(() => {
      const form = document.querySelector('.chat-composer');
      const bounds = selector => form.querySelector(selector).getBoundingClientRect().toJSON();
      const canvas = form.querySelector('canvas');
      return { input: bounds('textarea'), plus: bounds('[aria-label="Add files and tools"]'), wave: bounds('[data-slot="composer-voice"]'), mic: bounds('[aria-label="Stop dictation"]'), model: form.querySelector('.effort-trigger'), pixels: [...canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data].filter((_, index) => index % 4 === 3).some(alpha => alpha > 0) };
    });
    assert.equal(geometry.model, null, 'Model picker is replaced during capture');
    assert.ok(geometry.input.bottom <= geometry.wave.y, 'Live transcript sits above the waveform');
    assert.ok(geometry.plus.right <= geometry.wave.x && geometry.wave.right <= geometry.mic.x, 'Waveform sits between plus and mic');
    assert.ok(geometry.wave.width > 100 && geometry.pixels, 'Real captured audio draws a visible waveform');
    const waveBefore = await page.locator('.composer-voice-wave').evaluate(canvas => canvas.toDataURL());
    await page.waitForFunction(previous => document.querySelector('.composer-voice-wave').toDataURL() !== previous, waveBefore);
    await page.screenshot({ path: resolve('artifacts/dictation-listening-light.png') });
    const initial = await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue();
    assert.ok(initial.startsWith('Draft prefix '), initial);
    const setTheme = async theme => {
      await page.evaluate(theme => {
        const key = 'tinygpt-appearance-v4';
        const preferences = JSON.parse(localStorage.getItem(key));
        preferences.theme = theme;
        const newValue = JSON.stringify(preferences);
        localStorage.setItem(key, newValue);
        window.dispatchEvent(new StorageEvent('storage', { key, newValue }));
      }, theme);
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
    };
    await setTheme('dark');
    assert.equal(await page.locator('.composer-voice-wave').evaluate(canvas => getComputedStyle(canvas).color), 'rgb(237, 237, 239)');
    await page.screenshot({ path: resolve('artifacts/dictation-listening-dark.png') });
    await setTheme('light');
    await page.getByRole('button', { name: 'Stop dictation', exact: true }).click();
    await page.getByRole('button', { name: 'Dictate message', exact: true }).waitFor();
    const text = await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue();
    assert.ok(text.length > 'Draft prefix'.length && text.startsWith('Draft prefix '));
    assert.equal(await page.locator('.dictation-status').count(), 0);
    assert.equal(await page.locator('[data-slot="composer-voice"]').count(), 0);
    assert.ok(await page.locator('.chat-composer .effort-trigger').isVisible(), 'Model picker returns after capture');
    // Typing wins over in-flight transcription and stops capture.
    await page.getByRole('button', { name: 'Dictate message', exact: true }).click();
    await page.locator('[data-slot="composer-voice"][data-recording]').waitFor();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Edited draft');
    await page.getByRole('button', { name: 'Dictate message', exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Edited draft');
    await page.getByRole('button', { name: 'Dictate message', exact: true }).click();
    await page.locator('[data-slot="composer-voice"][data-recording]').waitFor();
    await page.getByRole('textbox', { name: 'Message', exact: true }).press('Escape');
    await page.getByRole('button', { name: 'Dictate message', exact: true }).waitFor();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Edit fixture');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByText('Fixture reply.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Edit message', exact: true }).click();
    const edit = page.locator('[data-slot="edit-message"]');
    await edit.getByRole('button', { name: 'Dictate message', exact: true }).click();
    await page.locator('[data-slot="composer-voice"][data-recording]').waitFor();
    await page.waitForFunction(() => document.querySelector('[aria-label="Edit message"]').value.length > 'Edit fixture'.length);
    await page.screenshot({ path: resolve('artifacts/dictation-edit.png') });
    await edit.getByRole('textbox', { name: 'Edit message', exact: true }).press('Escape');
    await edit.getByRole('button', { name: 'Dictate message', exact: true }).waitFor();
    assert.ok(await edit.isVisible(), 'Escape should stop dictation while keeping the editor open');
    await edit.getByRole('button', { name: 'Cancel', exact: true }).click();
    const opened = desktop.waitForEvent('window');
    await page.getByRole('button', { name: 'Pop out chat', exact: true }).click();
    const floating = await opened;
    await floating.getByRole('button', { name: 'Dictate message', exact: true }).click();
    await floating.locator('[data-slot="composer-voice"][data-recording]').waitFor();
    await floating.waitForFunction(() => document.querySelector('[aria-label="Message"]').value.length > 0);
    await floating.screenshot({ path: resolve('artifacts/dictation-floating.png') });
    await floating.getByRole('button', { name: 'Stop dictation', exact: true }).click();
    await floating.getByRole('button', { name: 'Dictate message', exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log('PASS: real microphone capture → worklet → IPC → Nemotron streaming → composer, draft preservation, manual edit cancellation, Escape, light/dark UI.');
  } catch (error) {
    if (page) { console.error(await page.locator('body').innerText()); await page.screenshot({ path: resolve('artifacts/dictation-ui-failure.png') }).catch(() => {}); }
    throw error;
  } finally { await desktop.close(); await new Promise(resolve => chat.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });

