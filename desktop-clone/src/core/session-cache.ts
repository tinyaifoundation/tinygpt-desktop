export interface SessionBacking<T> { get(key: string): Promise<T | undefined>; put(key: string, value: T): Promise<void>; remove(key: string): Promise<void> }
/** Evict to local storage before releasing a draft. Failed storage never drops
 * edits; callers surface the error rather than silently throwing data away. */
export class SessionCache<T> {
  private entries = new Map<string, { value: T; bytes: number; persisted: boolean }>();
  private trimming?: Promise<void>;
  constructor(private backing: SessionBacking<T>, private weight: (value: T) => number, private maxBytes = 16 * 1024 * 1024, private maxEntries = 16) {}
  peek(key: string): T | undefined { const entry = this.entries.get(key); if (!entry) return; this.entries.delete(key); this.entries.set(key, entry); return entry.value; }
  async get(key: string): Promise<T | undefined> { const cached = this.peek(key); if (cached !== undefined) return cached; const value = await this.backing.get(key); if (value !== undefined) { this.entries.set(key, { value, bytes: this.weight(value), persisted: true }); await this.trim(); } return value; }
  async set(key: string, value: T): Promise<void> {
    const previous = this.entries.get(key); this.entries.delete(key); this.entries.set(key, { value, bytes: this.weight(value), persisted: false });
    if (previous?.persisted) await this.backing.remove(key);
    await this.trim();
  }
  private async trim(): Promise<void> {
    if (this.trimming) { await this.trimming; if (this.overBudget()) return this.trim(); return; }
    const task = (async () => {
      while (this.overBudget()) {
        const [key, entry] = this.entries.entries().next().value!;
        if (!entry.persisted) await this.backing.put(key, entry.value);
        if (this.entries.get(key) === entry) this.entries.delete(key);
      }
    })(); this.trimming = task;
    try { await task; } finally { if (this.trimming === task) this.trimming = undefined; }
  }
  // The current workspace owns its live edits. A single large active snapshot
  // is spilled when navigation adds the next entry, never on every keystroke.
  private overBudget() { return this.entries.size > 1 && (this.entries.size > this.maxEntries || [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0) > this.maxBytes); }
  stats() { return { entries: this.entries.size, bytes: [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0) }; }
}
