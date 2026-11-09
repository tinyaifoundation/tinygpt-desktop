const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', `bot-transitions-${Date.now()}`) };
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  const desktop = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: ['--force-device-scale-factor=1', resolve('scripts/bot-conversation-smoke-main.cjs')], env });
  const errors = [];
  try {
    const page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    await page.evaluate(async () => { const snapshot = (await window.tinygpt.snapshot()).value; const result = await window.tinygpt.saveSettings({ ...snapshot.settings, route: 'local', local: { ...snapshot.settings.local, model: 'transition-fixture', endpoint: 'http://127.0.0.1:12345/v1' } }); if (!result.ok) throw Error(result.error); });
    await page.reload();
    await page.getByRole('button', { name: 'Your Bot', exact: true }).click();
    await page.getByRole('button', { name: 'Next', exact: true }).waitFor(); await page.waitForTimeout(550);
    const metrics = await page.evaluate(() => {
      window.setupAvatar = document.querySelector('.bot-preview-stage [data-robot-avatar]');
      const rect = window.setupAvatar.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    const switchStep = async (name, motion = true) => {
      const proof = await page.evaluate(({ name }) => {
        const button = [...document.querySelectorAll('.bot-designer-next > button')].find(button => button.textContent.includes(name));
        button.focus(); button.click();
        const snapshots = [...document.querySelectorAll('.bot-step-snapshot')];
        const root = document.querySelector('.bot-designer');
        return { snapshots: snapshots.length, inert: snapshots.every(element => element.inert && element.getAttribute('aria-hidden') === 'true'), animations: root.getAnimations({ subtree: true }).filter(animation => animation.effect.target.matches('.bot-introduction, .bot-design-controls, .bot-designer-next')).length, focused: document.activeElement.textContent, sameAvatar: window.setupAvatar === document.querySelector('.bot-preview-stage [data-robot-avatar]') };
      }, { name });
      assert.equal(proof.sameAvatar, true); assert.equal(proof.inert, true);
      assert.equal(proof.snapshots, motion ? 3 : 0); assert.equal(proof.animations, motion ? 6 : 0);
      assert.match(proof.focused, name === 'Next' ? /Start chatting/ : /Next/);
    };
    const settle = () => page.waitForFunction(() => !document.querySelector('.bot-designer').getAnimations({ subtree: true }).some(animation => animation.effect.target.matches('.bot-introduction, .bot-design-controls, .bot-designer-next')));
    await switchStep('Next'); await settle();
    await page.screenshot({ path: resolve('artifacts/bot-transition-step-two.png') });
    const after = await page.evaluate(() => { const rect = document.querySelector('.bot-preview-stage [data-robot-avatar]').getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; });
    assert.deepEqual(after, metrics);
    await switchStep('Go back'); await settle();
    await switchStep('Next'); await switchStep('Go back'); await settle();
    assert.equal(await page.locator('.bot-step-snapshot').count(), 0);
    await page.evaluate(() => { document.documentElement.dataset.motion = 'reduce'; window.dispatchEvent(new Event('tinygpt-motion')); });
    await switchStep('Next', false); await switchStep('Go back', false);
    await page.evaluate(() => { document.documentElement.dataset.motion = 'full'; window.dispatchEvent(new Event('tinygpt-motion')); });
    await switchStep('Next');
    await page.evaluate(() => { document.documentElement.dataset.motion = 'reduce'; window.dispatchEvent(new Event('tinygpt-motion')); });
    assert.equal(await page.locator('.bot-step-snapshot').count(), 0);
    await page.evaluate(() => { const preferences = JSON.parse(localStorage.getItem('tinygpt-appearance-v4')); preferences.theme = 'dark'; preferences.reduceMotion = 'off'; localStorage.setItem('tinygpt-appearance-v4', JSON.stringify(preferences)); });
    await page.reload(); await page.getByRole('region', { name: 'Bot setup', exact: true }).waitFor(); await page.waitForTimeout(550);
    await page.evaluate(() => { window.setupAvatar = document.querySelector('.bot-preview-stage [data-robot-avatar]'); });
    await switchStep('Go back'); await settle(); await switchStep('Next'); await settle();
    await page.screenshot({ path: resolve('artifacts/bot-transition-step-two-dark.png') });
    await desktop.evaluate(({ BrowserWindow }, url) => { BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === url).setSize(850, 600); }, page.url());
    await page.waitForFunction(() => innerWidth === 850);
    await switchStep('Go back'); await settle(); await switchStep('Next'); await settle();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await switchStep('Go back');
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    assert.equal(await page.locator('.bot-step-snapshot').count(), 0); assert.deepEqual(errors, []);
    console.log('Bot setup transitions passed: staged crossfade, stable live avatar, forward/back and rapid reversal, keyboard focus, reduced motion including mid-transition, cleanup, both themes and narrow layout.');
  } finally { await desktop.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
