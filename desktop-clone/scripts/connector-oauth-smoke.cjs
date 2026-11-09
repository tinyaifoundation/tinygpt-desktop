const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', `connector-oauth-${Date.now()}`) }; env.TINYGPT_VOICE_PROFILE = env.TINYGPT_TOOLS_PROFILE; delete env.ELECTRON_RUN_AS_NODE;
  const desktop = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/tools-smoke-main.cjs'), '--disable-features=CalculateNativeWinOcclusion'], env });
  const errors = [];
  try {
    const page = await desktop.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: 'Plugins library', exact: true }).waitFor();
    await desktop.evaluate(async ({ BrowserWindow, shell }) => {
      const mainWindow = BrowserWindow.getAllWindows()[0]; mainWindow.setIgnoreMouseEvents(true); mainWindow.setPosition(-10000, -10000); mainWindow.webContents.setBackgroundThrottling(false);
      global.appLinkCalls = [];
      await mainWindow.webContents.session.protocol.handle('tinygpt', request => { global.appLinkCalls.push(request.url); return new Response(null, { status: 204 }); });
      const nativeFetch = globalThis.fetch; global.oauthHealthChecks = 0;
      globalThis.fetch = async (url, options) => {
        if (['https://oauth2.googleapis.com/token','https://plugin.tinygpt.org/oauth/google/token'].includes(String(url))) return new Response(JSON.stringify({ access_token: 'isolated-oauth-token', refresh_token: 'isolated-refresh-token', expires_in: 3600, scope: 'https://www.googleapis.com/auth/gmail.readonly' }), { headers: { 'Content-Type': 'application/json' } });
        if (String(url) === 'https://gmail.googleapis.com/gmail/v1/users/me/profile') { global.oauthHealthChecks++; return new Response(JSON.stringify({ emailAddress: 'fixture@example.org' }), { headers: { 'Content-Type': 'application/json' } }); }
        return nativeFetch(url, options);
      };
      shell.openExternal = async url => {
        const auth = new URL(url); if (auth.origin !== 'https://accounts.google.com') throw new Error('Unexpected test URL');
        const callback = new URL(auth.searchParams.get('redirect_uri')); callback.search = new URLSearchParams({ state: auth.searchParams.get('state'), code: 'isolated-authorization-code' }).toString();
        const browser = new BrowserWindow({ width: 900, height: 720, show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } }); browser.setPosition(-10000, -10000); browser.setIgnoreMouseEvents(true); browser.webContents.setBackgroundThrottling(false); await browser.loadURL(callback.toString()); browser.showInactive();
      };
    });
    await page.getByRole('button', { name: 'Plugins library', exact: true }).click(); await page.getByRole('button', { name: 'View Gmail', exact: true }).click(); await page.getByRole('button', { name: 'Connect', exact: true }).click();
    const dialog = page.getByRole('dialog'); assert.equal(await dialog.getByRole('button', { name: 'Advanced setup', exact: true }).count(), 0); assert.equal(await dialog.getByText('Use an access token instead', { exact:true }).count(), 0);
    const newWindow = desktop.waitForEvent('window'); await dialog.getByRole('button', { name: 'Sign in with Google', exact: true }).click(); const callback = await newWindow; callback.on('pageerror', error => errors.push(error.message));
    await callback.getByRole('heading', { name: 'You’re connected', exact: true }).waitFor(); await dialog.waitFor({ state: 'hidden' });
    const entries = (await page.evaluate(() => window.tinygpt.plugins())).value.entries; const gmail = entries.find(entry => entry.manifest.connector === 'gmail'); assert.equal(gmail.status, 'connected'); assert.equal(gmail.account.email, 'fixture@example.org'); assert.ok(gmail.tools.some(tool => tool.originalName === 'search_mail')); assert.ok(gmail.tools.some(tool => tool.originalName === 'read_mail')); assert.ok(!gmail.tools.some(tool => tool.category === 'send')); assert.equal(await desktop.evaluate(() => global.oauthHealthChecks), 1); assert.ok(!JSON.stringify(entries).includes('isolated-oauth-token'));
    assert.equal(new URL(callback.url()).pathname, '/oauth/complete'); assert.equal(new URL(callback.url()).search, '');
    await callback.evaluate(() => document.fonts.ready); assert.ok(await callback.evaluate(() => getComputedStyle(document.body).fontFamily.includes('Figtree') && document.fonts.check('400 14px Figtree') && document.fonts.check('600 28px Figtree')));
    await callback.emulateMedia({ colorScheme: 'light' }); await callback.screenshot({ path: resolve('artifacts/oauth-callback-light.png'), animations: 'disabled' }); await callback.emulateMedia({ colorScheme: 'dark' }); await callback.screenshot({ path: resolve('artifacts/oauth-callback-dark.png'), animations: 'disabled' });
    await callback.setViewportSize({ width: 320, height: 568 }); assert.ok(await callback.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await callback.screenshot({ path: resolve('artifacts/oauth-callback-narrow.png'), animations: 'disabled' });
    assert.equal(await callback.getByRole('button').count(), 0); assert.equal(await callback.getByText('A secure connection to your desktop.', { exact: true }).count(), 0); assert.equal(await callback.getByText('You can close this tab.', { exact: true }).count(), 1);
    for (let i = 0; i < 50 && !(await desktop.evaluate(() => global.appLinkCalls.length)); i++) await new Promise(done => setTimeout(done, 50)); assert.deepEqual(await desktop.evaluate(() => global.appLinkCalls), ['tinygpt://open']);
    assert.deepEqual(errors, []); console.log(JSON.stringify({ checks: ['publisher sign-in without developer or access-token setup', 'complete browser authorization and account health', 'ready Gmail tool catalog', 'query credentials removed from browser history', 'bundled desktop typography', 'light/dark and narrow callback page', 'no return button or extra footer copy', 'one token-free deep link only after successful health check'], errors }));
  } finally { await desktop.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
