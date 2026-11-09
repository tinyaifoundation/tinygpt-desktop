import { BrowserWindow } from 'electron';
import { join } from 'node:path';
import { ModelAssets, readModelAssetCatalog } from './model-assets';

export async function prepareModelAssets(resources: string, userData: string, version: string, icon: string | Electron.NativeImage): Promise<string> {
  const catalog = await readModelAssetCatalog(resources);
  if (!catalog) return resources;
  const controller = new AbortController();
  const window = new BrowserWindow({ width: 480, height: 330, resizable: false, show: false, title: 'TinyGPT', icon, backgroundColor: '#ffffff', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>body{font:14px system-ui;color:#171717;background:#fff;padding:44px}h1{font-size:26px;font-weight:500;letter-spacing:-1px;margin:0 0 28px}p{color:#777;line-height:1.6;font-size:13px}progress{width:100%;height:5px;accent-color:#171717}small{display:block;color:#777;margin-top:14px}</style></head><body><h1>TinyGPT</h1><p id="message">Getting your local models ready.</p><progress id="progress" max="100" value="0"></progress><small id="detail">Models are kept for future app updates.</small></body></html>'));
  const delayed = setTimeout(() => { if (!window.isDestroyed()) window.show(); }, 1800);
  window.on('closed', () => controller.abort());
  let last = 0;
  try {
    return await new ModelAssets(join(userData, 'model-assets'), resources).prepare(catalog, version, controller.signal, state => {
      if (window.isDestroyed() || Date.now() - last < 180) return; last = Date.now();
      const progress = Math.min(100, state.bytes / state.totalBytes * 100);
      void window.webContents.executeJavaScript(`document.getElementById('progress').value=${progress};document.getElementById('message').textContent=${JSON.stringify(state.downloading ? 'Downloading your local models. You only need these once.' : 'Getting your local models ready.')};document.getElementById('detail').textContent=${JSON.stringify(`${Math.floor(progress)}% · Models are kept for future updates.`)}`).catch(() => {});
    });
  } catch (error) {
    if (controller.signal.aborted) throw Object.assign(Error('Model setup was canceled.'), { code: 'MODEL_SETUP_CANCELED' });
    throw Object.assign(Error('Local model setup could not finish. Check your connection and reopen TinyGPT to continue. Downloaded parts are kept.'), { code: 'MODEL_SETUP_FAILED' });
  } finally { clearTimeout(delayed); if (!window.isDestroyed()) window.destroy(); }
}
