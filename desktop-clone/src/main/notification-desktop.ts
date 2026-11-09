import { BrowserWindow, Notification } from 'electron';
import { randomUUID } from 'node:crypto';
import type { ActivityNotification, NotificationSound } from '../shared/notifications';
import type { NotificationSoundStore } from './notification-sound';

export class NotificationDesktop {
  private views = new Map<number, { conversationId: string | null; visible: boolean }>();
  private toasts = new Map<string, Notification>();
  private sounds = new Map<string, { owner: number; done: (played: boolean) => void }>();
  private pendingOpen: { conversationId: string; owner: number } | null = null;
  constructor(private options: {
    main: () => BrowserWindow | null; floating: () => BrowserWindow | null; floatingConversation: () => string | null;
    createMain: () => void; icon: string; sound: NotificationSoundStore;
    soundPreferences: () => { source: 'default' | 'custom'; volume: number };
  }) {}
  supported(): boolean { return Notification.isSupported(); }
  viewing(conversationId: string): boolean {
    return [this.options.main(), this.options.floating()].some(window => {
      if (!window || window.isDestroyed() || !window.isVisible() || window.isMinimized() || !window.isFocused()) return false;
      const view = this.views.get(window.webContents.id); return !!view?.visible && view.conversationId === conversationId;
    });
  }
  view(owner: BrowserWindow, value: { conversationId: string | null; visible: boolean }): void {
    this.views.set(owner.webContents.id, value);
    if (this.pendingOpen?.owner === owner.webContents.id) {
      const id = this.pendingOpen.conversationId; this.pendingOpen = null;
      owner.webContents.send('tinygpt:notification-open', id);
    }
  }
  open(conversationId: string): void {
    const floating = this.options.floating();
    if (floating && !floating.isDestroyed() && this.options.floatingConversation() === conversationId) { floating.show(); floating.focus(); return; }
    if (!this.options.main() || this.options.main()!.isDestroyed()) this.options.createMain();
    const main = this.options.main(); if (!main || main.isDestroyed()) return;
    if (main.isMinimized()) main.restore(); main.show(); main.focus();
    if (this.views.has(main.webContents.id) && !main.webContents.isLoading()) main.webContents.send('tinygpt:notification-open', conversationId);
    else this.pendingOpen = { conversationId, owner: main.webContents.id };
  }
  show(entry: ActivityNotification, preview: string | null, open: () => void, failed: () => void): void {
    const toast = new Notification({ title: `TinyGPT · ${entry.title}`, body: preview ?? (entry.kind === 'attention' ? 'Open TinyGPT to continue.' : entry.kind === 'failed' ? 'Open TinyGPT to review what happened.' : 'Your reply is ready to read.'), silent: true, icon: this.options.icon });
    this.toasts.set(entry.id, toast);
    toast.on('click', () => { try { open(); } catch { /* The chat may have been deleted. */ } });
    toast.on('close', () => this.toasts.delete(entry.id));
    toast.on('failed', () => { this.toasts.delete(entry.id); failed(); });
    // Bound native object retention independently of the durable Activity feed.
    if (this.toasts.size > 32) { const oldest = this.toasts.keys().next().value!; this.toasts.get(oldest)?.close(); this.toasts.delete(oldest); }
    toast.show();
  }
  test(failed: () => void): void {
    if (!this.supported()) { failed(); return; }
    this.show({ id: randomUUID(), sequence: 0, conversationId: '', messageId: null, kind: 'completed', mode: 'chat', title: 'Test notification', detail: '', createdAt: Date.now(), read: true, resolved: false }, 'Desktop notifications are connected to TinyGPT.', () => {
      if (!this.options.main() || this.options.main()!.isDestroyed()) this.options.createMain();
      const main = this.options.main(); if (main?.isMinimized()) main.restore(); main?.show(); main?.focus();
    }, failed);
  }
  async play(owner?: BrowserWindow): Promise<void> {
    const target = owner ?? this.options.main() ?? this.options.floating();
    if (!target || target.isDestroyed()) throw new Error('The notification sound player is not ready. Try again.');
    const preferences = this.options.soundPreferences();
    const payload: NotificationSound = { id: randomUUID(), url: this.options.sound.url(preferences.source), volume: preferences.volume };
    const played = await new Promise<boolean>(resolve => {
      const timeout = setTimeout(() => { this.sounds.delete(payload.id); resolve(false); }, 4000);
      this.sounds.set(payload.id, { owner: target.webContents.id, done: value => { clearTimeout(timeout); this.sounds.delete(payload.id); resolve(value); } });
      target.webContents.send('tinygpt:notification-sound', payload);
    });
    if (!played) throw new Error('Notification sound could not play. Try another WAV or MP3 file.');
  }
  soundResult(owner: BrowserWindow, id: string, played: boolean): void { const pending = this.sounds.get(id); if (pending?.owner === owner.webContents.id) pending.done(played); }
  close(): void {
    for (const toast of this.toasts.values()) toast.close(); this.toasts.clear();
    for (const pending of [...this.sounds.values()]) pending.done(false); this.sounds.clear(); this.views.clear();
  }
}
