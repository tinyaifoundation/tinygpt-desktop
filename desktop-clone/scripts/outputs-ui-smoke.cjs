const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { resolve, join } = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
async function main() {
  const profile = resolve('.tools-smoke-profile', `outputs-ui-${Date.now()}`); const root = join(profile, 'project'); mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'plan.md'), '# Launch plan\n\nA real saved output.'); writeFileSync(join(root, 'index.html'), '<!doctype html><title>Launch site</title><h1>Launch site</h1>');
  writeFileSync(join(root, 'budget.csv'), 'Item,Cost\nHosting,10');
  writeFileSync(join(root, 'hero.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: ['--force-device-scale-factor=1', resolve('scripts/tools-smoke-main.cjs')], env }); const errors = [];
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: 'Library', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Library', exact: true }).click(); await page.getByRole('heading', { name: 'Your outputs live here' }).waitFor();
    const ids = await page.evaluate(async () => { const project = await window.tinygpt.createProject('Launch', ''); const chat = await window.tinygpt.createConversation(project.value.id); await window.tinygpt.renameConversation(chat.value.id, 'Launch outputs'); return { project: project.value.id, chat: chat.value.id }; });
    const db = new DatabaseSync(join(profile, 'library.sqlite'));
    try {
      db.prepare('UPDATE projects SET root_path=? WHERE id=?').run(root, ids.project);
      const insert = db.prepare('INSERT INTO tool_calls(id,conversation_id,run_id,name,summary,status,result,created_at) VALUES(?,?,?,?,?,?,?,?)');
      ['plan.md', 'index.html', 'hero.png', 'budget.csv', 'plan.md'].forEach((path, index) => insert.run(randomUUID(), ids.chat, randomUUID(), 'write_project_file', 'Fixture', 'success', JSON.stringify({ artifact: { kind: 'project-file', path, projectId: ids.project } }), Date.now() + index));
      insert.run(randomUUID(), ids.chat, randomUUID(), 'read_project_file', 'Input only', 'success', JSON.stringify({ path: 'input.md' }), Date.now());
    } finally { db.close(); }
    await page.reload(); await page.getByRole('button', { name: 'Library', exact: true }).click();
    await page.locator('.outputs-table tbody tr').nth(3).waitFor(); assert.equal(await page.locator('.outputs-table tbody tr').count(), 4);
    assert.equal(await page.locator('.conversation-header').innerText(), '');
    assert.equal(await page.getByRole('button', { name: 'Library', exact: true }).locator('svg.lucide-library').count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Scheduled', exact: true }).locator('svg.lucide-clock').count(), 1);
    for (const [tab, name] of [['Pages', 'plan.md'], ['Sites', 'index.html'], ['Images', 'hero.png']]) { await page.getByRole('tab', { name: tab, exact: true }).click(); assert.equal(await page.locator('.outputs-table tbody tr').count(), 1); await page.getByRole('button', { name: `Open ${name}`, exact: true }).waitFor(); }
    await page.getByRole('tab', { name: 'All', exact: true }).click(); await page.getByRole('textbox', { name: 'Search outputs' }).fill('budget'); assert.equal(await page.locator('.outputs-table tbody tr').count(), 1);
    await page.getByRole('textbox', { name: 'Search outputs' }).fill('no matching filename'); await page.getByRole('heading', { name: 'No matching outputs' }).waitFor();
    await page.getByRole('textbox', { name: 'Search outputs' }).fill(''); await page.getByRole('button', { name: 'Sort outputs' }).click(); await page.getByRole('menuitemradio', { name: 'Name', exact: true }).click();
    assert.match(await page.locator('.outputs-table tbody tr').first().innerText(), /budget.csv/);
    async function catalogGeometry() {
      return page.locator('.catalog-content').evaluate(content => {
        const box = node => { const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, fontSize: style.fontSize, padding: style.padding, gap: style.gap, radius: style.borderRadius }; };
        return { contentPadding: getComputedStyle(content).padding, header: box(content.querySelector('.catalog-header')), title: box(content.querySelector('h1')), search: box(content.querySelector('.catalog-search')), tab: box(document.querySelector('.catalog-tabs button')), card: box(content.querySelector('.catalog-card')), icon: box(content.querySelector('.catalog-card-icon')), gridGap: getComputedStyle(content.querySelector('.catalog-grid')).gap };
      });
    }
    async function compareCatalogs(theme) {
      const outputs = await catalogGeometry();
      await page.getByRole('button', { name: 'Plugins library', exact: true }).click(); await page.getByRole('heading', { name: 'Popular', exact: true }).waitFor();
      const plugins = await catalogGeometry();
      for (const [label, left, right] of [
        ['content padding', outputs.contentPadding, plugins.contentPadding], ['content width', outputs.header.width, plugins.header.width], ['title position', outputs.title.x, plugins.title.x], ['title top', outputs.title.y, plugins.title.y], ['title font', outputs.title.fontSize, plugins.title.fontSize], ['search size', [outputs.search.width, outputs.search.height], [plugins.search.width, plugins.search.height]], ['tab sizing', [outputs.tab.height, outputs.tab.padding, outputs.tab.fontSize], [plugins.tab.height, plugins.tab.padding, plugins.tab.fontSize]], ['card size', [outputs.card.width, outputs.card.height, outputs.card.padding, outputs.card.gap], [plugins.card.width, plugins.card.height, plugins.card.padding, plugins.card.gap]], ['icon size', [outputs.icon.width, outputs.icon.height, outputs.icon.radius], [plugins.icon.width, plugins.icon.height, plugins.icon.radius]], ['grid gap', outputs.gridGap, plugins.gridGap]
      ]) assert.deepEqual(left, right, `${theme}: ${label} must match Plugins`);
      const add = page.getByRole('button', { name: 'Add', exact: true }); assert.ok((await add.boundingBox()).width > 70);
      await page.screenshot({ path: resolve(`artifacts/plugins-catalog-${theme}.png`) });
      if (theme === 'dark') {
        await add.click(); await page.getByRole('menuitem', { name: 'Custom MCP server', exact: true }).waitFor(); await page.keyboard.press('Escape');
        await page.getByRole('tab', { name: 'Skills', exact: true }).click(); await page.getByRole('heading', { name: 'Available skills', exact: true }).waitFor();
        await page.getByRole('tab', { name: 'MCP', exact: true }).click(); await page.getByRole('heading', { name: 'MCP servers', exact: true }).waitFor();
      }
      await page.getByRole('button', { name: 'Library', exact: true }).click(); await page.locator('.outputs-table tbody tr').nth(3).waitFor();
    }
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { const value = JSON.parse(localStorage.getItem('tinygpt-appearance-v4')); localStorage.setItem('tinygpt-appearance-v4', JSON.stringify({ ...value, theme })); }, theme);
      await page.reload(); await page.getByRole('button', { name: 'Library', exact: true }).click(); await page.locator('.outputs-table tbody tr').nth(3).waitFor();
      await compareCatalogs(theme);
      await page.mouse.move(30, 20); await page.screenshot({ path: resolve(`artifacts/outputs-library-${theme}.png`) });
    }
    await page.getByRole('button', { name: 'Grid view' }).click(); assert.equal(await page.locator('.outputs-grid button').count(), 4); await page.screenshot({ path: resolve('artifacts/outputs-library-grid.png') });
    await page.getByRole('button', { name: 'Open plan.md', exact: true }).click(); await page.getByRole('button', { name: 'Switch conversation: Launch outputs' }).waitFor(); await page.getByText('A real saved output.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Library', exact: true }).click(); assert.equal(await page.getByRole('button', { name: 'Grid view' }).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: 'Open hero.png', exact: true }).click(); await page.locator('.workspace-image img[alt="hero.png"]').waitFor();
    assert.equal(await page.locator('.workspace-image img').evaluate(image => image.complete && image.naturalWidth > 0), true);
    await page.getByRole('button', { name: 'Library', exact: true }).click(); await page.getByRole('button', { name: 'List view' }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(720, 800)); await compareCatalogs('narrow'); await page.screenshot({ path: resolve('artifacts/outputs-library-narrow.png') });
    assert.equal(await page.locator('.outputs-content').evaluate(node => node.scrollWidth > node.clientWidth), false);
    await page.getByRole('button', { name: 'Back to chat', exact: true }).click(); assert.equal(await page.locator('.outputs-library').count(), 0);
    assert.deepEqual(errors, []); console.log('Outputs UI passed: empty state, durable files, categories, deduplication, input exclusion, search, sorting, list/grid persistence, sidebar icons, document/image previews, themes, narrow layout, Back navigation and matching Plugins catalog geometry.');
  } finally { await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

