const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const { createServer } = require('node:http');
const { resolve, join } = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  let app;
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/models') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'notice-actions', context_length: 64000 }] }));
    if (req.url !== '/v1/chat/completions') return res.writeHead(404).end();
    let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw);
    const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'notice-actions', object: 'chat.completion.chunk', model: 'notice-actions', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (JSON.stringify(body.messages).includes('Describe a saved conversation')) return res.end(frame({ content: JSON.stringify({ title: 'Reply notice actions', summary: 'Reviewing recovery actions.', topicChanged: false }) }) + frame({}, 'stop') + 'data: [DONE]\n\n');
    const last = body.messages.filter(m => m.role === 'user').at(-1);
    if (last.content === 'Hold this reply') return res.write(frame({ role: 'assistant', content: 'New saved partial.' }));
    res.end(frame({ role: 'assistant', content: ' and continued.' }) + frame({}, 'stop') + 'data: [DONE]\n\n');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const profile = resolve('.tools-smoke-profile', `notice-actions-${Date.now()}`);
  try {
    const env = { ...process.env, TINYGPT_TOOLS_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/tools-smoke-main.cjs')], env });
    const page = await app.firstWindow(); page.setDefaultTimeout(25000); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) { w.setPosition(-10000, -10000); w.setIgnoreMouseEvents(true); w.webContents.setBackgroundThrottling(false); w.showInactive(); } });
    await page.evaluate(async endpoint => {
      const settings = (await window.tinygpt.snapshot()).value.settings;
      const saved = await window.tinygpt.saveSettings({ ...settings, mode: 'chat', local: { ...settings.local, endpoint, model: 'notice-actions', tools: false } }); if (!saved.ok) throw Error(saved.error);
      const used = await window.tinygpt.useLocalModel(endpoint, 'notice-actions'); if (!used.ok) throw Error(used.error);
    }, `http://127.0.0.1:${server.address().port}/v1`);
    const created = (await page.evaluate(() => window.tinygpt.createConversation(null))).value;
    const db = new DatabaseSync(join(profile, 'library.sqlite')); db.exec('PRAGMA busy_timeout=5000');
    let parent = null, now = Date.now();
    for (const [status, error] of [['error', 'The provider could not finish this reply.'], ['interrupted', 'TinyGPT closed before this reply finished. You can retry it.']]) {
      for (const role of ['user', 'assistant']) {
        const id = randomUUID();
        db.prepare('INSERT INTO messages(id,conversation_id,role,text,status,error,created_at,route,parent_id) VALUES(?,?,?,?,?,?,?,?,?)').run(id, created.id, role, role === 'user' ? `Review ${status}` : status === 'interrupted' ? 'Saved partial' : 'Earlier failed answer', role === 'user' ? 'complete' : status, role === 'user' ? null : error, now++, 'local', parent);
        parent = id;
      }
    }
    const interruptedId = parent;
    db.prepare('UPDATE conversations SET active_leaf=?,title=? WHERE id=?').run(parent, 'Reply notice actions', created.id); db.close();
    await page.reload();
    const notice = page.locator('[data-slot="error-state"][data-tone="muted"]'); await notice.waitFor();
    assert.equal(await notice.count(), 1); assert.equal(await page.locator('[data-slot="stopped-run"]').count(), 0);
    assert.equal(await notice.getByRole('button', { name: 'Continue', exact: true }).count(), 1);
    assert.equal(await notice.getByRole('button', { name: 'Discard', exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Retry failed reply', exact: true }).count(), 1);
    assert.equal(await notice.locator('[data-variant="outline"]').count(), 0);
    for (const theme of ['Light', 'Dark']) {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Appearance', exact: true }).click();
      await page.getByRole('button', { name: theme, exact: true }).click();
      await page.getByRole('button', { name: 'Back to TinyGPT', exact: true }).click(); await notice.waitFor();
      assert.ok(await notice.evaluate(e => [...e.querySelectorAll('button')].every(b => { const r = b.getBoundingClientRect(), c = e.getBoundingClientRect(); return r.top >= c.top && r.bottom <= c.bottom && r.right <= c.right; })));
      await page.screenshot({ path: resolve(`artifacts/reply-notice-actions-${theme.toLowerCase()}.png`) });
    }
    const idle = async () => { for (let i = 0; i < 250; i++) { const library = (await page.evaluate(() => window.tinygpt.library())).value; if (!library.activeRuns.length) return; await page.waitForTimeout(100); } throw Error('Reply did not finish.'); };
    await notice.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByText('Saved partial and continued.', { exact: true }).waitFor(); await idle();
    assert.equal(await notice.count(), 0);
    const continued = (await page.evaluate(id => window.tinygpt.conversation(id), created.id)).value;
    assert.equal(continued.messages.at(-1).continuationOf, interruptedId);
    assert.equal(continued.allMessages.find(m => m.id === interruptedId).text, 'Saved partial');
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Hold this reply');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByText('New saved partial.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Stop reply', exact: true }).click(); await notice.waitFor(); await idle();
    await notice.getByText('Reply stopped', { exact: true }).waitFor();
    assert.equal(await notice.count(), 1); assert.equal(await page.locator('[data-slot="stopped-run"]').count(), 0);
    await notice.getByRole('button', { name: 'Discard', exact: true }).click(); await notice.waitFor({ state: 'detached' });
    assert.equal(await page.getByText('New saved partial.', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Retry failed reply', exact: true }).count(), 1);
    assert.deepEqual(errors, []);
    console.log('Passed: one recovery card, embedded ghost controls, light/dark layouts, Continue preserves original branch, Stop gets one card, Discard works, failure Retry preserved.');
  } catch (e) { if (app) await (await app.firstWindow()).screenshot({ path: resolve('artifacts/reply-notice-actions-failure.png') }).catch(() => {}); throw e; }
  finally { if (app) await app.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
