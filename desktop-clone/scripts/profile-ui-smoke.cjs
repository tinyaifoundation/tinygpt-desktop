// Profile fixtures use only this test's disposable SQLite library.
const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', `profile-ui-${Date.now()}`) }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: ['--force-device-scale-factor=1', resolve('scripts/tools-smoke-main.cjs')], env });
  const errors = [];
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    const ids = await page.evaluate(async () => {
      const project = await window.tinygpt.createProject('Profile project', '');
      const chat = await window.tinygpt.createConversation(project.value.id);
      await window.tinygpt.renameConversation(chat.value.id, 'Profile fixture conversation');
      const unknown = await window.tinygpt.createConversation(null);
      await window.tinygpt.renameConversation(unknown.value.id, 'Unknown usage conversation');
      localStorage.setItem('tinygpt-profile-v4', JSON.stringify({ name: 'Taylor', handle: 'taylor', avatar: '' }));
      return { chat: chat.value.id, unknown: unknown.value.id };
    });
    const days = (() => {
      const { DatabaseSync } = require('node:sqlite'); const { randomUUID } = require('node:crypto');
      const db = new DatabaseSync(resolve(env.TINYGPT_TOOLS_PROFILE, 'library.sqlite'));
      const dayKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      let parent = null; let lastRun;
      try {
        for (let index = 0; index < 7; index++) {
          const date = new Date(); date.setHours(12, 0, 0, 0); date.setDate(date.getDate() - 6 + index);
          const user = randomUUID(); const assistant = randomUUID(); const run = randomUUID();
          const insert = db.prepare('INSERT INTO messages(id,conversation_id,role,text,status,created_at,run_id,route,parent_id) VALUES(?,?,?,?,?,?,?,?,?)');
          insert.run(user, ids.chat, 'user', 'Profile usage fixture', 'complete', date.getTime(), null, 'local', parent);
          insert.run(assistant, ids.chat, 'assistant', 'Saved response', 'complete', date.getTime(), run, 'local', user);
          const tokens = index < 6 ? 891000 : 204924;
          db.prepare('INSERT INTO context_usage VALUES(?,?,?,?)').run(run, ids.chat, tokens - 100, 100);
          parent = assistant; lastRun = run;
        }
        db.prepare('UPDATE conversations SET active_leaf=? WHERE id=?').run(parent, ids.chat);
        const unknownDate = new Date(); unknownDate.setHours(12, 0, 0, 0); unknownDate.setDate(unknownDate.getDate() - 10);
        const unknownMessage = randomUUID();
        db.prepare('INSERT INTO messages(id,conversation_id,role,text,status,created_at,run_id,route) VALUES(?,?,?,?,?,?,?,?)').run(unknownMessage, ids.unknown, 'assistant', 'No saved usage', 'cancelled', unknownDate.getTime(), randomUUID(), 'local');
        db.prepare('UPDATE conversations SET active_leaf=? WHERE id=?').run(unknownMessage, ids.unknown);
        db.prepare('INSERT INTO tool_calls(id,conversation_id,run_id,name,summary,status,created_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(), ids.chat, lastRun, 'read_page', 'Fixture', 'success', Date.now());
        const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
        return { today: dayKey(new Date()), yesterday: dayKey(yesterday), unknown: dayKey(unknownDate) };
      } finally { db.close(); }
    })();
    await page.reload(); await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    const usage = (await page.evaluate(() => window.tinygpt.profileUsage())).value;
    assert.equal(usage.totalTokens, 5550924); assert.equal(usage.peakTokens, 891000); assert.equal(usage.missingUsage, true);
    assert.equal(usage.daily.reduce((sum, day) => sum + (day.tokens ?? 0), 0), usage.totalTokens);
    assert.equal(usage.daily.find(day => day.day === days.today).tokens, 204924);
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    assert.equal(await page.locator('.conversation-title-trigger').count(), 0);
    await page.getByRole('button', { name: 'Project: Choose project' }).click(); await page.getByRole('menuitemradio', { name: 'Profile project' }).click();
    const project = page.locator('.sidebar-project-row').filter({ hasText: 'Profile project' });
    await project.getByRole('button', { name: 'Profile project', exact: true }).click(); await page.mouse.move(700, 400);
    assert.equal(await project.evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
    assert.equal(await project.locator('.sidebar-hover-action').first().evaluate(node => getComputedStyle(node).opacity), '0');
    await project.getByRole('button', { name: 'Profile project', exact: true }).click(); await page.mouse.move(700, 400);
    assert.equal(await project.evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
    for (const label of ['Library', 'Plugins library', 'Scheduled']) {
      await page.getByRole('button', { name: label, exact: true }).click(); assert.equal(await page.locator('.conversation-header').innerText(), '');
    }
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { const value = JSON.parse(localStorage.getItem('tinygpt-appearance-v4')); localStorage.setItem('tinygpt-appearance-v4', JSON.stringify({ ...value, theme })); }, theme);
      await page.reload(); await page.getByRole('button', { name: 'Open profile menu' }).click();
      assert.equal(await page.locator('.profile-menu-identity .sidebar-profile-avatar').count(), 1);
      assert.equal(await page.locator('.profile-menu-identity strong').innerText(), 'Taylor');
      assert.equal(await page.getByRole('menuitem', { name: 'Profile', exact: true }).count(), 0);
      assert.equal(await page.locator('.profile-menu').getByText('@taylor', { exact: true }).count(), 0);
      await page.screenshot({ path: resolve(`artifacts/profile-menu-${theme}.png`) });
      await page.getByRole('menuitem', { name: 'View profile for Taylor' }).click();
      await page.getByRole('region', { name: 'Usage and activity' }).waitFor();
      assert.deepEqual(await page.locator('.usage-metrics strong').allTextContents(), ['5.5M', '891K', '7 turns', '7 days', '7 days']);
      assert.equal(await page.locator('.usage-metrics small').count(), 0);
      assert.equal(await page.getByText('Tokens use provider-reported counts.', { exact: false }).count(), 0);
      assert.equal(await page.getByText('Your profile stays on this computer.', { exact: false }).count(), 0);
      assert.equal(await page.locator('.activity-heatmap button').count(), 365);
      assert.ok(await page.locator('.activity-months span').count() >= 12);
      const yesterday = page.locator(`[data-day="${days.yesterday}"]`); await yesterday.click();
      assert.ok((await page.locator('.activity-detail').innerText()).includes('891,000 tokens'));
      await yesterday.press('ArrowDown'); assert.equal(await page.locator(`[data-day="${days.today}"]`).getAttribute('aria-pressed'), 'true');
      assert.ok((await page.locator('.activity-detail').innerText()).includes('204,924 tokens'));
      await page.locator(`[data-day="${days.unknown}"]`).click(); assert.ok((await page.locator('.activity-detail').innerText()).includes('— tokens'));
      await page.locator(`[data-day="${days.today}"]`).click();
      await page.screenshot({ path: resolve(`artifacts/profile-tokens-${theme}.png`) });
      await page.getByRole('button', { name: 'Back to TinyGPT' }).click(); await page.getByRole('button', { name: 'Collapse sidebar' }).click();
      const icons = await page.locator('.sidebar-header-actions svg.lucide, .sidebar-nav-action svg.lucide, .tiny-sidebar-settings svg.lucide, .tiny-sidebar-toolbar svg.lucide').evaluateAll(nodes => nodes.map(node => { const style = getComputedStyle(node); return `${style.width}:${style.height}:${style.color}`; }));
      assert.equal(new Set(icons).size, 1); assert.ok(icons[0].startsWith('17px:17px:'));
      await page.getByRole('button', { name: 'Expand sidebar' }).click();
    }
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Profile', exact: true }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(850, 820));
    assert.equal(await page.locator('.activity-scroll').evaluate(node => node.scrollWidth > node.clientWidth), true);
    await page.screenshot({ path: resolve('artifacts/profile-tokens-narrow.png') });
    assert.deepEqual(errors, []);
    console.log('Profile UI passed: persistent real token totals and daily activity, compact metrics, unknown usage, calendar selection and keyboard navigation, both themes and narrow layout, profile identity link, project hover reset, conversation-only titles, and uniform collapsed icons.');
  } catch (error) { await (await app.firstWindow()).screenshot({ path: resolve('artifacts/profile-ui-failure.png') }).catch(() => {}); throw error; }
  finally { await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
