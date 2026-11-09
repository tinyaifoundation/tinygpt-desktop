const { app, BrowserWindow, ipcMain, shell, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { gunzipSync } = require('node:zlib');
const { createStore } = require('./store.cjs');
const root = path.resolve(__dirname, '../..');
const dataDirectory = path.join(root, 'artifacts/tool-icon-audit');
const recordFile = path.join(dataDirectory, process.env.TOOL_ICON_AUDIT_TEST === '1' ? 'test-recorded-changes.json' : 'recorded-changes.json');
const store = createStore(recordFile);
app.setPath('userData', path.join(dataDirectory, process.env.TOOL_ICON_AUDIT_TEST === '1' ? 'test-app-profile' : 'app-profile'));
let window;
let catalog;
let preparation;
let refreshing = false;

async function prepare() {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', path.join(__dirname, 'audit-source.cjs')], { cwd: root, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore','pipe','pipe'] });
    let message = '';
    child.stderr.on('data', chunk => { message = (message + chunk).slice(-4000); });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error('Could not refresh the tool audit. ' + message)));
  });
  const audit = JSON.parse(await fs.readFile(path.join(dataDirectory, 'audit.json'), 'utf8'));
  const icons = JSON.parse(gunzipSync(await fs.readFile(path.join(dataDirectory, 'solar-linear.json.gz'))));
  catalog = { audit, icons };
  return catalog;
}
function trusted(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Unknown app window.');
}
ipcMain.handle('audit:load', async event => {
  trusted(event);
  preparation ??= prepare();
  try { await preparation; } catch (error) { preparation = null; throw error; }
  return { ...catalog, saved: await store.load(), recordFile };
});
ipcMain.handle('audit:refresh', async event => {
  trusted(event);
  if (!refreshing) {
    refreshing = true;
    preparation = prepare().finally(() => { refreshing = false; });
  }
  await preparation;
  return { ...catalog, saved: await store.load(), recordFile };
});
ipcMain.handle('audit:record', async (event, value) => {
  trusted(event); await preparation;
  const row = catalog.audit.rows.find(row => row.id === value?.tool);
  if (!row || row.editable === false || typeof value.solarSlug !== 'string' || !Object.hasOwn(catalog.icons,value.solarSlug)) throw new Error('Choose a supported tool and a valid installed Solar Linear slug.');
  if (value.solarSlug === row.slug) return store.remove(row.id);
  return store.record({ tool: row.id, toolName: row.name, group: row.group, currentSolarSlug: row.slug, solarSlug: value.solarSlug, recordedAt: new Date().toISOString() });
});
ipcMain.handle('audit:remove', async (event, tool) => { trusted(event); if (typeof tool !== 'string') throw new Error('Invalid tool.'); return store.remove(tool); });
ipcMain.handle('audit:show-file', async event => { trusted(event); try { await fs.access(recordFile); } catch { throw new Error('Save a replacement first to create the change file.'); } shell.showItemInFolder(recordFile); });
ipcMain.handle('audit:copy-request', async event => {
  trusted(event); const state = await store.load();
  const pending = state.replacements.filter(choice => catalog.audit.rows.some(row => row.id === choice.tool && row.editable !== false && row.slug !== choice.solarSlug));
  if (!pending.length) throw new Error('No pending icon changes. Record a new replacement first.');
  clipboard.writeText(`Apply only these pending Solar Linear toolchain icon replacements saved in ${recordFile}. Re-read the current production resolver first, preserve unrelated work, and change only the selected tools. Respect per-tool choices when an existing family rule takes precedence.\n\n${JSON.stringify(pending, null, 2)}`);
  return true;
});
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(() => {
    preparation = prepare();
    preparation.catch(() => {});
    window = new BrowserWindow({ title: 'TinyGPT · Tool Icon Auditor', width: 1440, height: 980, minWidth: 940, minHeight: 680, show: false, backgroundColor: '#f6f7f9', autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.once('ready-to-show', () => window.show());
    window.loadFile(path.join(__dirname, 'index.html'));
  });
  app.on('window-all-closed', () => app.quit());
}
