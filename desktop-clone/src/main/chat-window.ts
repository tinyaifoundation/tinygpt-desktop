import { BrowserWindow, screen } from 'electron';
import type { ChatWindowState } from '../shared/contracts';

/** One pinned conversation, backed by the existing main-process chat service. */
export class ChatWindow {
  window: BrowserWindow | null = null;
  state: ChatWindowState = { conversationId: null, returnedConversationId: null };
  constructor(private readonly options: {
    preload: string; url: string; main: () => BrowserWindow | null; createMain: () => void; icon?: string;
    quitting: () => boolean; changed: (state: ChatWindowState) => void;
  }) {}
  owns(contents: Electron.WebContents, frame: Electron.WebFrameMain | null) {
    return !!this.window && !this.window.isDestroyed() && contents === this.window.webContents
      && frame === contents.mainFrame && frame.url === this.options.url;
  }
  open(conversationId: string) {
    this.state = { conversationId, returnedConversationId: null };
    if (!this.window || this.window.isDestroyed()) {
      const bounds = this.options.main()?.getBounds();
      const area = screen.getDisplayMatching(bounds ?? screen.getPrimaryDisplay().workArea).workArea;
      const width = Math.min(440, area.width), height = Math.min(650, area.height);
      const floating = new BrowserWindow({
        width, height, minWidth: 320, minHeight: 420,
        x: Math.max(area.x, Math.min((bounds?.x ?? area.x) + (bounds?.width ?? area.width) - width - 24, area.x + area.width - width)),
        y: Math.max(area.y, Math.min((bounds?.y ?? area.y) + 64, area.y + area.height - height)),
        title: 'TinyGPT — Chat', frame: false, transparent: true, backgroundColor: '#00000000',
        icon: this.options.icon,
        roundedCorners: true, hasShadow: true, alwaysOnTop: true, show: false,
        minimizable: false, maximizable: false, fullscreenable: false, autoHideMenuBar: true,
        webPreferences: { preload: this.options.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required' },
      });
      this.window = floating;
      floating.removeMenu();
      floating.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      floating.webContents.on('will-navigate', (event, url) => { if (url !== this.options.url) event.preventDefault(); });
      floating.once('ready-to-show', () => { if (!floating.isDestroyed()) { floating.show(); floating.focus(); } });
      floating.on('closed', () => {
        this.window = null;
        if (!this.options.quitting() && this.state.conversationId) this.dock();
      });
      void floating.loadURL(this.options.url);
    } else { this.window.show(); this.window.focus(); }
    this.options.changed(this.state);
    return this.state;
  }
  dock(input: { settingsSection?: string; workspace?: ChatWindowState['workspace'] } = {}) {
    if (!this.state.conversationId) return this.state;
    this.state = { conversationId: null, returnedConversationId: this.state.conversationId, ...input };
    // Clear ownership before closing: close must never cancel a reply or dock twice.
    const floating = this.window; this.window = null;
    // Keep a live window throughout handoff so window-all-closed cannot quit.
    if (!this.options.main() || this.options.main()!.isDestroyed()) this.options.createMain();
    if (floating && !floating.isDestroyed()) floating.close();
    const main = this.options.main();
    if (main?.isMinimized()) main.restore();
    main?.show(); main?.focus();
    this.options.changed(this.state);
    return this.state;
  }
  forget(conversationId: string) {
    if (this.state.conversationId !== conversationId && this.state.returnedConversationId !== conversationId) return;
    this.state = { conversationId: null, returnedConversationId: null };
    this.window?.close(); this.window = null;
    this.options.changed(this.state);
  }
}
