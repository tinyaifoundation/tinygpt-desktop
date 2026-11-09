import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EventEmitter } from 'node:events';

interface SetupWindow extends EventEmitter {
  options: Record<string, unknown>;
  destroyed: boolean;
  webContents: EventEmitter & { mainFrame: object; executeJavaScript: ReturnType<typeof vi.fn> };
  close: ReturnType<typeof vi.fn>;
}
const fake = vi.hoisted(() => ({ windows: [] as SetupWindow[], catalog: vi.fn(), prepare: vi.fn() }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class Window extends EventEmitter {
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), { mainFrame: {}, setWindowOpenHandler: vi.fn(), executeJavaScript: vi.fn().mockResolvedValue(undefined) });
    constructor(public options: Record<string, unknown>) { super(); fake.windows.push(this as unknown as SetupWindow); }
    setMenuBarVisibility() {}
    async loadURL() {}
    show() {}
    isDestroyed() { return this.destroyed; }
    close = vi.fn(() => this.destroy());
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
  }
  return { BrowserWindow: Window, ipcMain: new EventEmitter() };
});
vi.mock('node:fs/promises', () => ({ readFile: vi.fn().mockResolvedValue(Buffer.from('bundled asset')) }));
vi.mock('../src/main/assets/dock-icons/tinygpt-ios-default.png?asset', () => ({ default: 'icon.png' }));
vi.mock('@fontsource-variable/figtree/files/figtree-latin-wght-normal.woff2?asset', () => ({ default: 'font.woff2' }));
vi.mock('../src/main/model-assets', () => ({
  readModelAssetCatalog: fake.catalog,
  ModelAssets: class { prepare(...args: unknown[]) { return fake.prepare(...args); } },
}));
import { ipcMain } from 'electron';
import { prepareModelAssets } from '../src/main/model-setup';

beforeEach(() => { fake.windows.length = 0; fake.catalog.mockResolvedValue({ files: [] }); fake.prepare.mockReset(); });
afterEach(() => { ipcMain.removeAllListeners(); });

it('does not open first-run setup when no model catalog is present', async () => {
  fake.catalog.mockResolvedValue(null);
  await expect(prepareModelAssets('/resources', '/profile', '1', '')).resolves.toBe('/resources');
  expect(fake.windows).toHaveLength(0);
});

it('only lets the setup main frame stop its active preparation and removes its listener', async () => {
  let signal!: AbortSignal;
  fake.prepare.mockImplementation((_catalog, _version, abort: AbortSignal, changed) => {
    signal = abort;
    changed({ bytes: 62, totalBytes: 100, downloading: true });
    return new Promise((_resolve, reject) => abort.addEventListener('abort', () => reject(abort.reason), { once: true }));
  });
  const pending = prepareModelAssets('/resources', '/profile', '1', '');
  await vi.waitFor(() => expect(fake.prepare).toHaveBeenCalledOnce());
  const window = fake.windows[0];
  ipcMain.emit('tinygpt:model-setup-stop', { sender: {}, senderFrame: window.webContents.mainFrame });
  ipcMain.emit('tinygpt:model-setup-stop', { sender: window.webContents, senderFrame: {} });
  expect(signal.aborted).toBe(false);
  expect(window.close).not.toHaveBeenCalled();
  const outcome = expect(pending).rejects.toMatchObject({ code: 'MODEL_SETUP_CANCELED' });
  ipcMain.emit('tinygpt:model-setup-stop', { sender: window.webContents, senderFrame: window.webContents.mainFrame });
  await outcome;
  expect(signal.aborted).toBe(true);
  expect(window.close).toHaveBeenCalledOnce();
  expect(ipcMain.listenerCount('tinygpt:model-setup-stop')).toBe(0);
});

it('cleans up the setup window on success and reports a resumable failure on error', async () => {
  fake.prepare.mockResolvedValue('/prepared');
  await expect(prepareModelAssets('/resources', '/profile', '1', '')).resolves.toBe('/prepared');
  expect(fake.windows[0].destroyed).toBe(true);
  fake.prepare.mockRejectedValue(Error('network unavailable'));
  await expect(prepareModelAssets('/resources', '/profile', '1', '')).rejects.toMatchObject({ code: 'MODEL_SETUP_FAILED', message: expect.stringContaining('reopen TinyGPT') });
  expect(fake.windows[1].destroyed).toBe(true);
  expect(ipcMain.listenerCount('tinygpt:model-setup-stop')).toBe(0);
});
