import type { UpdateAction, UpdateState } from '../shared/updates';
import { trustedUpdateFile } from '../shared/updates';

type Release = { version: string; releaseNotes?: string | { note: string }[] | null; files?: { url: string }[]; packages?: Record<string, { path: string }> };
export interface UpdateEngine {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  disableWebInstaller: boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(silent?: boolean, forceRunAfter?: boolean): void;
}

/** Owns updater state. Renderer callers cannot supply URLs or execute downloaded paths. */
export class AppUpdates {
  private state: UpdateState;
  private operation?: Promise<UpdateState>;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(private engine: UpdateEngine | undefined, version: string, private publish: (state: UpdateState) => void, private busy: () => boolean, private prepareInstall: () => Promise<void>, unavailableMessage = 'Updates are available in signed Windows release builds.') {
    this.state = { phase: engine ? 'idle' : 'unavailable', currentVersion: version, ...(!engine ? { message: unavailableMessage } : {}) };
    if (!engine) return;
    engine.autoDownload = false;
    engine.autoInstallOnAppQuit = false;
    engine.allowPrerelease = true;
    engine.allowDowngrade = false;
    engine.disableWebInstaller = false;
    engine.on('checking-for-update', () => { if (!['ready', 'downloading'].includes(this.state.phase)) this.set({ phase: 'checking' }); });
    engine.on('update-not-available', () => { if (!['ready', 'downloading'].includes(this.state.phase)) this.set({ phase: 'idle', version: undefined, notes: undefined, message: 'You’re up to date.' }); });
    engine.on('update-available', (release: Release) => {
      if (['downloading', 'ready'].includes(this.state.phase)) return;
      const paths = [...(release.files ?? []).map(file => file.url), ...Object.values(release.packages ?? {}).map(file => file.path)];
      if (!release.version || !paths.length || paths.some(path => !trustedUpdateFile(path))) { this.set({ phase: 'error', message: 'This update could not be verified. Try again later.' }); return; }
      const notes = typeof release.releaseNotes === 'string' ? release.releaseNotes : (release.releaseNotes ?? []).map(item => item.note).join('\n');
      this.set({ phase: 'available', version: release.version.slice(0, 100), notes: notes.slice(0, 6000), message: undefined, percent: undefined });
    });
    engine.on('download-progress', (progress: { percent: number }) => { if (this.state.phase === 'downloading') this.set({ percent: Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, progress.percent)) : 0 }); });
    engine.on('update-downloaded', () => { if (this.state.phase === 'downloading') this.set({ phase: 'ready', percent: 100, message: undefined }); });
    engine.on('error', () => this.fail());
  }
  snapshot(): UpdateState { return { ...this.state }; }
  private set(value: Partial<UpdateState>) { if (!this.closed) { this.state = { ...this.state, ...value }; this.publish(this.snapshot()); } }
  private fail() { this.set({ phase: 'error', percent: undefined, message: 'The update could not finish. Check your connection and try again.' }); }
  start(interval = 4 * 60 * 60 * 1000) {
    if (!this.engine || this.closed || this.timer) return;
    void this.action('check');
    this.timer = setInterval(() => { if (['idle', 'error'].includes(this.state.phase)) void this.action('check'); }, interval);
    this.timer.unref?.();
  }
  action(action: UpdateAction): Promise<UpdateState> {
    if (!this.engine || this.closed) return Promise.resolve(this.snapshot());
    if (this.operation) return this.operation;
    if (action === 'check' && ['ready', 'downloading'].includes(this.state.phase)) return Promise.resolve(this.snapshot());
    if (action === 'download' && this.state.phase !== 'available') return Promise.resolve(this.snapshot());
    if (action === 'install' && this.state.phase !== 'ready') return Promise.resolve(this.snapshot());
    this.operation = (async () => {
      try {
        if (action === 'check') { this.set({ phase: 'checking', message: undefined }); await this.engine!.checkForUpdates(); if (this.state.phase === 'checking') this.set({ phase: 'idle' }); }
        else if (action === 'download') { this.set({ phase: 'downloading', percent: 0, message: undefined }); await this.engine!.downloadUpdate(); }
        else {
          if (this.busy()) { this.set({ message: 'Finish active chats, Work tasks and terminals before restarting.' }); return this.snapshot(); }
          await this.prepareInstall();
          if (this.busy()) { this.set({ message: 'Finish active tasks before restarting.' }); return this.snapshot(); }
          this.engine!.quitAndInstall(true, true);
        }
      } catch { this.fail(); }
      return this.snapshot();
    })().finally(() => { this.operation = undefined; });
    return this.operation;
  }
  close() { this.closed = true; if (this.timer) clearInterval(this.timer); }
}
