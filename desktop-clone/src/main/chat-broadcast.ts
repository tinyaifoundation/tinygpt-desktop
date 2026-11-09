import type { BrowserWindow, WebContents } from 'electron';
import type { ChatUpdate } from '../shared/chat';
import { ChatUpdateEncoder } from '../core/chat-updates';

/** Coalesce delivery bursts across all active conversations, preserving order. */
export class ChatBroadcast {
  private pending = new Map<string, ChatUpdate>();
  private timer?: ReturnType<typeof setTimeout>;
  private encoders = new WeakMap<WebContents, ChatUpdateEncoder>();
  constructor(private windows: () => (BrowserWindow | null)[]) {}
  publish(update: ChatUpdate) {
    // Updating an existing Map key does not move it. Move it so the last
    // packet's library snapshot is the latest across concurrent conversations.
    this.pending.delete(update.conversation.id); this.pending.set(update.conversation.id, update);
    this.timer ??= setTimeout(() => this.flush(), 32);
  }
  private flush() {
    this.timer = undefined; const updates = [...this.pending.values()]; this.pending.clear();
    for (const window of this.windows()) {
      if (!window || window.isDestroyed()) continue;
      const contents = window.webContents; let encoder = this.encoders.get(contents);
      if (!encoder) { encoder = new ChatUpdateEncoder(); this.encoders.set(contents, encoder); contents.once('did-start-loading', () => this.encoders.delete(contents)); }
      contents.send('tinygpt:chat-update', updates.map(update => encoder!.encode(update)));
    }
  }
}
