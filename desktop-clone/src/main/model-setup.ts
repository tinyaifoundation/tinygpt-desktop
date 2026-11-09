import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ModelAssets, readModelAssetCatalog } from './model-assets';
import { modelSetupDocument } from './model-setup-view';
import setupIcon from './assets/dock-icons/tinygpt-ios-default.png?asset';
import setupFont from '@fontsource-variable/figtree/files/figtree-latin-wght-normal.woff2?asset';

export async function prepareModelAssets(resources: string, userData: string, version: string, icon: string | Electron.NativeImage): Promise<string> {
  const catalog = await readModelAssetCatalog(resources);
  if (!catalog) return resources;
  const controller = new AbortController();
  const [iconBytes, fontBytes] = await Promise.all([readFile(setupIcon), readFile(setupFont)]);
  const window = new BrowserWindow({
    width: 480, height: 354, resizable: false, maximizable: false, fullscreenable: false,
    show: false, title: 'Installing TinyGPT', icon,
    frame: false, transparent: true, backgroundColor: '#00000000', roundedCorners: true, hasShadow: true,
    webPreferences: { preload: join(__dirname, '../preload/model-setup.js'), nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  const stop = (event: IpcMainEvent) => {
    if (window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return;
    controller.abort();
    window.close();
  };
  ipcMain.on('tinygpt:model-setup-stop', stop);
  window.on('closed', () => controller.abort());
  let delayed: ReturnType<typeof setTimeout> | undefined;
  let last = 0;
  try {
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(modelSetupDocument(iconBytes, fontBytes)));
    delayed = setTimeout(() => { if (!window.isDestroyed()) window.show(); }, 1800);
    return await new ModelAssets(join(userData, 'model-assets'), resources).prepare(catalog, version, controller.signal, state => {
      if (window.isDestroyed() || Date.now() - last < 180) return; last = Date.now();
      const progress = state.totalBytes > 0 ? Math.max(0, Math.min(100, state.bytes / state.totalBytes * 100)) : 0;
      void window.webContents.executeJavaScript(`document.getElementById('progress').value=${progress};document.getElementById('percent').textContent=${JSON.stringify(`${Math.floor(progress)}%`)};document.body.dataset.downloading=${JSON.stringify(String(state.downloading))}`).catch(() => {});
    });
  } catch (error) {
    if (controller.signal.aborted) throw Object.assign(Error('TinyGPT installation was stopped.'), { code: 'MODEL_SETUP_CANCELED' });
    throw Object.assign(Error('TinyGPT could not finish installing. Check your internet connection and reopen TinyGPT to continue. Downloaded parts are kept.'), { code: 'MODEL_SETUP_FAILED' });
  } finally {
    clearTimeout(delayed);
    ipcMain.removeListener('tinygpt:model-setup-stop', stop);
    if (!window.isDestroyed()) window.destroy();
  }
}
