const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');
async function main() {
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', 'slider-style-' + Date.now()) };
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  const app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/tools-smoke-main.cjs')], env });
  const errors = [], metrics = [];
  try {
    const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.setPosition(-10000, -10000); window.webContents.setBackgroundThrottling(false); window.showInactive(); } });
    await page.getByRole('button', { name: 'New chat', exact: true }).waitFor();
    await page.evaluate(async () => { const settings = (await window.tinygpt.snapshot()).value.settings; const result = await window.tinygpt.saveSettings({ ...settings, mode: 'chat', route: 'byok', byok: { ...settings.byok, provider: 'openrouter', protocol: 'openai-compatible', endpoint: 'https://openrouter.ai/api/v1', model: '' }, openrouter: { ...settings.openrouter, nitro: true } }); if (!result.ok) throw Error(result.error); });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { const key = 'tinygpt-appearance-v4'; const value = JSON.parse(localStorage.getItem(key)); localStorage.setItem(key, JSON.stringify({ ...value, theme })); }, theme);
      await page.reload(); await page.getByRole('button', { name: /^Level of effort:/ }).click();
      const slider = page.getByRole('slider', { name: 'Level of effort', exact: true });
      for (const position of [0, 25, 50, 75, 100]) {
        await slider.press(position === 0 ? 'Home' : 'ArrowRight');
        await page.waitForFunction(position => { const slider = document.querySelector('.effort-range'); return Number(slider.value) === position && !slider.disabled; }, position);
        const sizes = await page.locator('.effort-slider-track').evaluate(track => { const range = document.querySelector('.effort-range'); const fill = track.querySelector('.effort-slider-fill'); return { track: track.getBoundingClientRect().width, fill: fill.getBoundingClientRect().width, thumb: Number(getComputedStyle(range).getPropertyValue('--effort-thumb-size').replace('px', '')), position: Number(range.value), dots: getComputedStyle(track).getPropertyValue('--effort-dot-color').trim(), nitro: getComputedStyle(document.querySelector('.effort-nitro')).color }; });
        const center = sizes.thumb / 2 + (sizes.track - sizes.thumb) * position / 100;
        assert.ok(Math.abs(sizes.fill - center) < .1, 'Fill ends at knob center: ' + JSON.stringify(sizes));
        if (theme === 'light') { assert.equal(sizes.dots, '#c5c7ce'); assert.equal(sizes.nitro, 'rgb(150, 150, 159)'); }
        if (position === 75 || position === 100) await page.screenshot({ path: resolve('artifacts/effort-slider-' + theme + '-' + position + '.png') });
        if (position === 100) assert.equal(await page.locator('.effort-max-star').count(), 14);
        metrics.push({ theme, ...sizes });
      }
      await page.keyboard.press('Escape'); if (theme === 'light') assert.equal(await page.locator('.effort-nitro-indicator').evaluate(el => getComputedStyle(el).color), 'rgb(150, 150, 159)');
    }
    assert.deepEqual(errors, []); console.log(JSON.stringify({ checks: ['Fill ends at knob midpoint for all five levels in both themes', 'Light dots are lighter', 'Light Nitro fill is muted in popover and composer', 'Max stars retained'], metrics, errors }));
  } finally { await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
