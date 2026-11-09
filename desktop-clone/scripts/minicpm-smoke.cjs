// Live, opt-in MiniCPM check. Reuses downloaded model assets but isolates chat/settings.
const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { mkdir, symlink, writeFile } = require('node:fs/promises');
const { resolve, join } = require('node:path');
const assert = require('node:assert/strict');
async function main() {
  const profile = resolve('.tools-smoke-profile', `minicpm-${Date.now()}`);
  await mkdir(profile, { recursive: true });
  await symlink(join(process.env.APPDATA, 'tinygpt-desktop', 'local-models'), join(profile, 'local-models'), 'junction');
  const env = { ...process.env, TINYGPT_CHAT_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/chat-smoke-main.cjs')], env, timeout: 30000 });
    const page = await app.firstWindow(); page.setDefaultTimeout(30000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Configuration', exact: true }).click();
    await page.getByRole('button', { name: 'Configure Local Model', exact: true }).click();
    await page.getByRole('heading', { name: 'MiniCPM5 2B · 64k', exact: true }).waitFor();
    const toggle = page.getByRole('switch', { name: 'MiniCPM speculative decoding', exact: true });
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await toggle.click(); assert.equal(await toggle.getAttribute('aria-checked'), 'true'); await toggle.click();
    await page.getByRole('button', { name: 'Download & run MiniCPM', exact: true }).click();
    await page.getByRole('button', { name: 'Use MiniCPM', exact: true }).waitFor({ timeout: 240000 });
    const snapshot = await page.evaluate(() => window.tinygpt.snapshot()); assert.equal(snapshot.ok, true);
    assert.equal(snapshot.value.settings.route, 'local'); assert.equal(snapshot.value.settings.local.model, 'MiniCPM5-2B');
    assert.equal(snapshot.value.settings.local.contextWindowTokens, 65536); assert.equal(snapshot.value.settings.local.maxOutputTokens, 8192); assert.equal(snapshot.value.settings.local.tools, true);
    const connected = await page.evaluate(() => window.tinygpt.checkConnection('local')); assert.equal(connected.ok, true); assert.equal(connected.value.modelContextWindowTokens, 65536);
    await page.screenshot({ path: resolve('artifacts/minicpm-configuration.png') });
    const conversation = await page.evaluate(async () => { const c = await window.tinygpt.createConversation(null); if (!c.ok) throw Error(c.error); const sent = await window.tinygpt.sendMessage(c.value.id, 'Reply with exactly: TinyGPT local harness ready.'); if (!sent.ok) throw Error(sent.error); return c.value.id; });
    const deadline = Date.now() + 120000;
    while (true) {
      const library = await page.evaluate(() => window.tinygpt.library()); assert.equal(library.ok, true);
      if (!library.value.activeRuns.some(run => run.conversationId === conversation)) break;
      if (Date.now() > deadline) throw Error('Live Chat harness timed out.');
      await new Promise(done => setTimeout(done, 200));
    }
    const reply = await page.evaluate(id => window.tinygpt.conversation(id), conversation); assert.equal(reply.ok, true);
    const message = reply.value.messages.at(-1); assert.equal(message.status, 'complete'); assert.match(message.text, /TinyGPT local harness ready/);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await page.getByText('Stopped. Downloaded files are kept for next time.', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    await writeFile(resolve('artifacts/minicpm-harness-proof.json'), JSON.stringify({ context: 65536, tools: true, status: message.status, answer: message.text, reasoning: !!message.reasoning, errors }, null, 2));
    console.log('MiniCPM live smoke passed: one-click setup, speculative toggle, CUDA startup, 64k discovery, actual TinyGPT Chat harness, and Stop.');
  } finally { if (app) await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
