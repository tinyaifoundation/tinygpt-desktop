import type { QueuedRequest, RunSteering } from '../shared/chat';

/** Worker-side inbox. Delivery is acknowledged only at an actual model boundary. */
export class SteeringInbox implements RunSteering {
  private items = new Map<string, QueuedRequest>();
  private wakes = new Set<() => void>();
  constructor(private consumed: (ids: string[]) => void = () => {}) {}
  add(items: QueuedRequest[]): void { for (const item of items) this.items.set(item.id, item); for (const wake of this.wakes) wake(); }
  pending(): QueuedRequest[] { return [...this.items.values()]; }
  subscribe(wake: () => void): () => void { this.wakes.add(wake); return () => { this.wakes.delete(wake); }; }
  consume(ids: string[]): QueuedRequest[] {
    const items = ids.flatMap(id => { const item = this.items.get(id); if (!item) return []; this.items.delete(id); return [item]; });
    if (items.length) this.consumed(items.map(item => item.id)); return items;
  }
}
