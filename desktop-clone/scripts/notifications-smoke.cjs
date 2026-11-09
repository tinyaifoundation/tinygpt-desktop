// Real Electron, IPC, SQLite activity, worker streaming, native toast click wiring and renderer audio.
const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { resolve, join } = require('node:path');
const { mkdir, writeFile } = require('node:fs/promises');
const assert = require('node:assert/strict');
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function main() {
  const profile = resolve('.tools-smoke-profile', `notifications-${Date.now()}`); await mkdir(profile, { recursive: true }); await mkdir('artifacts', { recursive: true });
  let finish; let app; let page; const errors = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    const input = JSON.parse(raw); const text = input.messages.filter(message => message.role === 'user').at(-1)?.content;
    if (String(text).includes('FAIL')) { response.writeHead(500).end('Fixture failure'); return; }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'notification-fixture', object: 'chat.completion.chunk', model: 'notification-fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    response.write(frame({ role: 'assistant', content: 'Working… ' }));
    finish = () => response.end(frame({ content: 'Private reply content.' }) + frame({}, 'stop') + 'data: [DONE]\n\n');
    if (!String(text).includes('HOLD')) setTimeout(() => { if (!response.destroyed) finish(); }, 100);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE;
  async function bridge(method, ...args) { const result = await page.evaluate(async ({ method, args }) => window.tinygpt[method](...args), { method, args }); assert.equal(result.ok, true, result.error); return result.value; }
  async function wait(predicate, label) { const until = Date.now() + 45000; while (Date.now() < until) { if (await predicate()) return; await sleep(100); } throw new Error(`Timed out: ${label}`); }
  async function launch() {
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/tools-smoke-main.cjs')], env });
    page = await app.firstWindow(); page.setDefaultTimeout(30000); page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow, Notification }) => {
      globalThis.fixtureToasts = []; globalThis.fixtureNativeShow = Notification.prototype.show; Notification.prototype.show = function () { globalThis.fixtureToasts.push(this); };
      for (const window of BrowserWindow.getAllWindows()) { window.setIgnoreMouseEvents(true); window.setPosition(-10000, -10000); window.webContents.setAudioMuted(true); window.webContents.setBackgroundThrottling(false); window.showInactive(); }
    });
    await page.getByRole('button', { name: 'New chat', exact: true }).waitFor();
  }
  try {
    await launch(); const { settings } = await bridge('snapshot');
    await bridge('saveSettings', { ...settings, route: 'local', mode: 'chat', local: { ...settings.local, endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: 'notification-fixture', tools: false } });
    await page.reload(); await page.getByRole('textbox', { name: 'Message', exact: true }).fill('HOLD notification'); await page.getByRole('textbox', { name: 'Message', exact: true }).press('Enter');
    await wait(async () => !!finish && (await bridge('library')).activeRuns.length === 1, 'streaming worker');
    const id = (await bridge('library')).activeRuns[0].conversationId;
    await page.getByRole('button', { name: 'New chat', exact: true }).click(); finish();
    await wait(async () => (await bridge('notifications')).unreadCount === 1, 'unread completion');
    await page.locator('.sidebar-activity .activity-indicator').waitFor();
    await page.getByRole('button', { name: 'View activity', exact: true }).click();
    await page.locator('.notification-row[data-unread]').waitFor();
    const native = await app.evaluate(() => globalThis.fixtureToasts.map(toast => ({ title: toast.title, body: toast.body, silent: toast.silent })));
    assert.equal(native.length, 1); assert.equal(native[0].silent, true); assert.ok(!native[0].body.includes('Private'));
    await page.screenshot({ path: resolve('artifacts/notifications-activity.png') });
    await app.evaluate(() => globalThis.fixtureToasts[0].emit('click'));
    await wait(async () => (await bridge('library')).lastConversationId === id && (await bridge('notifications')).unreadCount === 0, 'native click opens and reads chat');
    await page.keyboard.press('Escape');
    await bridge('previewNotificationSound');
    // The actual renderer decodes and plays the copied clip; test windows are muted.
    const wav = Buffer.alloc(44 + 4800); wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(4800, 40);
    const clip = join(profile, 'Custom chime.wav'); await writeFile(clip, wav);
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, clip);
    const chosen = await bridge('chooseNotificationSound'); assert.equal(chosen.customSoundName, 'Custom chime.wav'); await bridge('previewNotificationSound');
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('button', { name: 'Notifications', exact: true }).click();
    await page.getByRole('switch', { name: 'Play notification sound', exact: true }).click();
    await wait(async () => (await bridge('snapshot')).settings.notifications.sound.enabled, 'saved sound toggle');
    await page.getByRole('switch', { name: 'Notification quiet hours', exact: true }).click();
    await page.getByLabel('Quiet hours start', { exact: true }).waitFor();
    await page.screenshot({ path: resolve('artifacts/notifications-settings.png') });
    await page.getByRole('switch', { name: 'Notification unread dots', exact: true }).click();
    await wait(async () => !(await bridge('snapshot')).settings.notifications.badges, 'saved badge toggle');
    await bridge('notificationAction', { action: 'clear-read' }); assert.equal((await bridge('notifications')).items.length, 0);
    await app.close(); app = null; await launch();
    assert.equal((await bridge('notifications')).items.length, 0); assert.equal((await bridge('notifications')).customSoundName, 'Custom chime.wav');
    assert.equal((await bridge('snapshot')).settings.notifications.badges, false); assert.equal(await app.evaluate(() => globalThis.fixtureToasts.length), 0);
    await bridge('previewNotificationSound'); assert.deepEqual(errors, []);
    if (process.argv.includes('--native-check')) {
      await app.evaluate(({ Notification }) => { Notification.prototype.show = globalThis.fixtureNativeShow; });
      await bridge('testDesktopNotification'); await sleep(1500);
      const result = await bridge('notifications'); assert.equal(result.desktopSupported, true); assert.equal(result.deliveryError, null, result.deliveryError);
      console.log('Native Windows notification accepted without a delivery error.');
    }
    console.log('Notification smoke passed: worker completion, unread dots/feed, private native toast, click/read, settings, default/custom audio and restart persistence.');
  } finally { if (app) await app.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
