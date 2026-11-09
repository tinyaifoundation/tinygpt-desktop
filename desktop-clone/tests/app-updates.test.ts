import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { AppUpdates, type UpdateEngine } from '../src/main/app-updates';
import { trustedUpdateFile, updateActionSchema } from '../src/shared/updates';

function setup(busy = () => false) {
  const engine = Object.assign(new EventEmitter(), { autoDownload: true, autoInstallOnAppQuit: true, allowPrerelease: false, allowDowngrade: true, disableWebInstaller: true, checkForUpdates: vi.fn(async () => {}), downloadUpdate: vi.fn(async () => {}), quitAndInstall: vi.fn() });
  const prepare = vi.fn(async () => {}), publish = vi.fn();
  const updates = new AppUpdates(engine as UpdateEngine, '0.1.0-prebeta.3', publish, busy, prepare);
  const release = () => engine.emit('update-available', { version: '0.1.0-prebeta.4', files: [{ url: 'https://downloads.tinygpt.org/releases/0.1.0-prebeta.4/TinyGPT-Setup.exe' }], releaseNotes: '<script>plain text only</script>' });
  return { engine, updates, release, prepare, publish };
}
it('never downloads or installs just because a new release is discovered', async () => {
  const { engine, updates, release } = setup(); release();
  expect(engine.autoDownload).toBe(false); expect(engine.autoInstallOnAppQuit).toBe(false); expect(engine.allowDowngrade).toBe(false);
  expect(updates.snapshot().phase).toBe('available'); expect(engine.downloadUpdate).not.toHaveBeenCalled(); expect(engine.quitAndInstall).not.toHaveBeenCalled();
  await updates.action('download'); expect(engine.downloadUpdate).toHaveBeenCalledTimes(1);
  engine.emit('download-progress', { percent: 64.8 }); expect(updates.snapshot().percent).toBe(64.8);
  engine.emit('update-downloaded'); expect(updates.snapshot().phase).toBe('ready');
  await updates.action('check'); expect(updates.snapshot().phase).toBe('ready'); expect(engine.checkForUpdates).not.toHaveBeenCalled();
  await updates.action('install'); expect(engine.quitAndInstall).toHaveBeenCalledWith(true, true);
});
it('keeps a verified download ready while active work blocks a restart', async () => {
  let busy = true; const { engine, updates, release, prepare } = setup(() => busy); release(); await updates.action('download'); engine.emit('update-downloaded');
  await updates.action('install'); expect(updates.snapshot().phase).toBe('ready'); expect(updates.snapshot().message).toMatch(/Finish active/); expect(prepare).not.toHaveBeenCalled(); expect(engine.quitAndInstall).not.toHaveBeenCalled();
  busy = false; await updates.action('install'); expect(engine.quitAndInstall).toHaveBeenCalledTimes(1);
});
it('deduplicates download clicks and hides network details on errors', async () => {
  const { engine, updates, release } = setup(); release(); let finish!: () => void;
  engine.downloadUpdate.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const first = updates.action('download'), second = updates.action('download'); expect(first).toBe(second); expect(engine.downloadUpdate).toHaveBeenCalledTimes(1);
  engine.emit('error', new Error('private local path and credential')); finish(); await first;
  expect(updates.snapshot().message).not.toMatch(/credential|local path/); expect(updates.snapshot().phase).toBe('error');
});
it('rejects an update that redirects artifact metadata off the release host', async () => {
  const { engine, updates } = setup(); engine.emit('update-available', { version: '4', files: [{ url: 'https://other.example/installer.exe' }] });
  expect(updates.snapshot().phase).toBe('error'); await updates.action('download'); expect(engine.downloadUpdate).not.toHaveBeenCalled();
  for (const value of ['../file.exe', '//other.example/file.exe', 'https://downloads.tinygpt.org@other.example/releases/4/a.exe', 'https://downloads.tinygpt.org/releases/4/a.exe?token=secret']) expect(trustedUpdateFile(value)).toBe(false);
  expect(updateActionSchema.safeParse({ action: 'install', url: 'anything' }).success).toBe(false);
});
it('does not offer an unsigned development build an update engine', async () => {
  const updates = new AppUpdates(undefined, '3', vi.fn(), () => false, vi.fn()); updates.start(1);
  await updates.action('install'); expect(updates.snapshot().phase).toBe('unavailable'); updates.close();
});
