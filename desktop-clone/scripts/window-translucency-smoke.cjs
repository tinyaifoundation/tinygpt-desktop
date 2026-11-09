// Audit actual composed pixels, not just each element's background declaration.
const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { resolve } = require('node:path');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const python = process.env.TINYGPT_PYTHON || 'python';
const inspectPixels = 'import json,sys\nfrom PIL import Image\nim=Image.open(sys.argv[1]).convert("RGBA")\nprint(json.dumps({name:list(im.getpixel((int(x),int(y)))) for name,x,y in json.loads(sys.argv[2])}))';

async function main() {
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', `translucency-${Date.now()}`) }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: ['--force-device-scale-factor=1', resolve('scripts/tools-smoke-main.cjs')], env });
  const errors = [];
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    const nav = page.getByRole('navigation', { name: 'Settings sections' });
    async function appearance() { await page.getByRole('button', { name: 'Settings', exact: true }).click(); await nav.getByRole('button', { name: 'Appearance', exact: true }).click(); }
    async function audit(label, enabled, settings = false) {
      await page.mouse.move(400, 200);
      await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'));
      const frame = await page.evaluate(settings => {
        const sidebar = document.querySelector(settings ? '.settings-sidebar' : '.tiny-sidebar').getBoundingClientRect();
        const header = document.querySelector(settings ? '.settings-top-drag' : '.conversation-header').getBoundingClientRect();
        const pane = document.querySelector(settings ? '.settings-content' : '.conversation-pane').getBoundingClientRect();
        return { points: [['sidebar', sidebar.left + 5, sidebar.top + sidebar.height / 2], ['header', header.left + 80, header.top + 31], ['controls', innerWidth - 100, 33], ['right', innerWidth - 4, innerHeight / 2], ['bottom', innerWidth / 2, innerHeight - 4], ['rightBorder', innerWidth - 1, innerHeight / 2], ['bottomBorder', innerWidth / 2, innerHeight - 1], ['content', pane.left + 20, pane.bottom - 20]], backgrounds: [...document.querySelectorAll(settings ? '.settings-workspace,.settings-sidebar,.settings-main,.settings-top-drag,.window-controls,.window-control' : '.desktop-shell > main,.tiny-sidebar,.conversation-header,.window-controls,.window-control')].map(node => ({ name: node.className, color: getComputedStyle(node).backgroundColor })) };
      }, settings);
      for (const background of frame.backgrounds) assert.equal(background.color, 'rgba(0, 0, 0, 0)', `${label}: ${background.name} should share the single frame surface`);
      const path = resolve(`artifacts/translucent-window-${label}.png`); await page.screenshot({ path, omitBackground: true });
      const pixels = JSON.parse(execFileSync(python, ['-c', inspectPixels, path, JSON.stringify(frame.points)], { encoding: 'utf8' }));
      for (const name of ['sidebar', 'header', 'controls', 'right', 'bottom', 'rightBorder', 'bottomBorder']) assert.ok(Math.abs(pixels[name][3] - (enabled ? 235 : 255)) <= 2, `${label}: ${name} alpha ${pixels[name][3]}`);
      assert.equal(pixels.content[3], 255, `${label}: reading surface remains solid`);
    }
    await appearance();
    assert.equal(await page.getByText('Translucent sidebar', { exact: true }).count(), 0);
    for (const theme of ['light', 'dark']) {
      const label = theme === 'light' ? 'Light theme' : 'Dark theme';
      await page.getByRole('button', { name: theme === 'light' ? 'Light' : 'Dark', exact: true }).click();
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
      await audit(`${theme}-settings-off`, false, true);
      await page.getByRole('switch', { name: `${label} translucent window`, exact: true }).click();
      await page.waitForFunction(() => document.documentElement.dataset.translucent === 'true');
      await audit(`${theme}-settings-on`, true, true);
      await page.getByRole('button', { name: 'Back to TinyGPT', exact: true }).click();
      await audit(`${theme}-chat`, true);
      for (const name of ['Minimize window', 'Close window']) {
        const button = page.getByRole('button', { name, exact: true }); await button.hover();
        const box = await button.boundingBox(); const path = resolve(`artifacts/translucent-window-${theme}-${name.split(' ')[0].toLowerCase()}-hover.png`);
        await page.screenshot({ path, omitBackground: true });
        const pixel = JSON.parse(execFileSync(python, ['-c', inspectPixels, path, JSON.stringify([['hover', box.x + 8, box.y + box.height - 5]])], { encoding: 'utf8' })).hover;
        assert.ok(pixel[3] > 235 && pixel[3] < 255, `${theme}: ${name} hover remains translucent`);
      }
      for (const [name, view] of [['Library', 'library'], ['Plugins library', 'plugins'], ['Scheduled', 'scheduled']]) {
        await page.getByRole('button', { name, exact: true }).click(); await audit(`${theme}-${view}`, true);
      }
      await page.getByRole('button', { name: 'New chat', exact: true }).click();
      await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click(); await audit(`${theme}-collapsed`, true);
      await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
      await page.getByRole('button', { name: 'Maximize window', exact: true }).click(); await page.waitForFunction(() => document.querySelector('.desktop-shell').dataset.maximized === 'true');
      assert.equal(await page.locator('.desktop-shell').evaluate(node => getComputedStyle(node).borderRadius), '0px'); await audit(`${theme}-maximized`, true);
      await page.getByRole('button', { name: 'Restore window', exact: true }).click(); await page.waitForFunction(() => document.querySelector('.desktop-shell').dataset.maximized === 'false');
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(850, 600)); await audit(`${theme}-narrow`, true);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 820));
      await appearance();
    }
    // Both old stored palette keys remain usable and survive reloading.
    const preferences = await page.evaluate(() => JSON.parse(localStorage.getItem('tinygpt-appearance-v4')));
    assert.equal(preferences.light.translucentSidebar, true); assert.equal(preferences.dark.translucentSidebar, true);
    await page.reload(); await page.getByRole('button', { name: 'Settings', exact: true }).waitFor(); assert.equal(await page.locator('html').getAttribute('data-translucent'), 'true');
    await audit('dark-restored', true);
    await appearance(); await page.getByRole('switch', { name: 'Dark theme translucent window', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.translucent === 'false');
    await page.getByRole('button', { name: 'Back to TinyGPT', exact: true }).click(); await audit('dark-chat-off', false);
    assert.deepEqual(errors, []);
    console.log('Window translucency passed: 92% composed frame alpha across sidebar/header/window controls/right/bottom, solid content, both themes, off state, Settings/Library/Plugins/Scheduled, collapsed sidebar, maximized/restored/narrow window, renamed switch, and legacy preference persistence.');
  } catch (error) { const page = await app.firstWindow(); await page.screenshot({ path: resolve('artifacts/translucent-window-failure.png'), omitBackground: true }); console.error('Renderer errors:', errors); throw error; }
  finally { await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
