import type { DesktopBridge } from '../../shared/contracts';
import type { ChatUpdate } from '../../shared/chat';
import { ChatUpdateDecoder } from '../../core/chat-updates';

type Store = { listeners: Set<(update: ChatUpdate) => void> };
const stores = new WeakMap<DesktopBridge, Store>();
/** Reconstruct compact packets in the renderer world, preserving references
 * without copying full histories across the context bridge for each listener. */
export function subscribeChatUpdates(bridge: DesktopBridge, listener: (update: ChatUpdate) => void): () => void {
  if (!bridge.onChatPackets) return bridge.onChatUpdate(listener);
  let store = stores.get(bridge);
  if (!store) {
    store = { listeners: new Set() }; stores.set(bridge, store); const decoder = new ChatUpdateDecoder(), current = store;
    bridge.onChatPackets(packets => { for (const packet of packets) { const update = decoder.decode(packet); for (const subscriber of current.listeners) subscriber(update); } });
  }
  store.listeners.add(listener); return () => { store!.listeners.delete(listener); };
}
