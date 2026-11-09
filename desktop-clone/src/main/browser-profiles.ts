import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { app, session } from 'electron';
import { z } from 'zod';
import type { BrowserPreferences } from '../shared/config';
import type { BrowserHistoryEntry } from '../shared/workspace';
import { pageUrlSchema } from '../shared/tools';
import { blockedBrowserRequest, browserHeaders, browserUserAgent } from '../core/browser-privacy';

const partitionSchema = z.string().regex(/^persist:tinygpt-browser(?:-[a-f\d-]{36})?$/);
const stateSchema = z.object({
  profiles: z.array(partitionSchema).max(10000),
  history: z.array(z.object({ url: pageUrlSchema, title: z.string().max(300), visitedAt: z.number().finite().nonnegative(), partition: partitionSchema }).strict()).max(500),
}).strict();

export class BrowserProfiles {
  private profiles = new Set<string>(['persist:tinygpt-browser']);
  private configured = new Set<string>();
  private visits: (BrowserHistoryEntry & { partition: string })[] = [];
  private queue: Promise<void> = Promise.resolve();
  constructor(private directory: string, private preferences: () => BrowserPreferences) {}
  async load(): Promise<void> {
    try {
      const state = stateSchema.parse(JSON.parse(await readFile(join(this.directory, 'browser-data.json'), 'utf8')));
      for (const profile of state.profiles) this.profiles.add(profile);
      this.visits = state.history;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Saved browser history could not be read. Your files have been preserved.'); }
  }
  private persist(): Promise<void> {
    const value = JSON.stringify({ profiles: [...this.profiles], history: this.visits });
    const next = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true });
      const file = join(this.directory, 'browser-data.json'); const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, value, { mode: 0o600 }); await rename(temporary, file);
    });
    this.queue = next.catch(() => {}); return next;
  }
  register(partition: string): void {
    partitionSchema.parse(partition);
    if (!this.profiles.has(partition)) { this.profiles.add(partition); void this.persist().catch(() => {}); }
  }
  configure(partition: string): void {
    this.register(partition);
    this.configured.add(partition);
    const profile = session.fromPartition(partition);
    const agent = browserUserAgent(process.versions.chrome, process.platform); const locale = app.getLocale() || 'en-US';
    profile.setUserAgent(agent, locale);
    // Leave verification providers available. Brave's separate AI answer is
    // unnecessary when TinyGPT is already synthesizing its search results.
    void profile.cookies.set({ url: 'https://search.brave.com', name: 'summarizer', value: '0' }).catch(() => {});
    profile.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => callback({ cancel: blockedBrowserRequest(details.url, details.resourceType, this.preferences().adBlock) }));
    profile.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, callback) => callback({ requestHeaders: browserHeaders(details.requestHeaders, agent, locale) }));
  }
  record(partition: string, url: string, title: string): void {
    if (!pageUrlSchema.safeParse(url).success) return;
    const previous = this.visits[0];
    if (previous?.partition === partition && previous.url === url && Date.now() - previous.visitedAt < 1500) return;
    this.visits.unshift({ partition, url, title: (title || new URL(url).hostname).slice(0, 300), visitedAt: Date.now() }); this.visits.length = Math.min(this.visits.length, 500);
    void this.persist().catch(() => {});
  }
  title(partition: string, url: string, title: string): void {
    const visit = this.visits.find(entry => entry.partition === partition && entry.url === url);
    if (visit && title && visit.title !== title.slice(0, 300)) { visit.title = title.slice(0, 300); void this.persist().catch(() => {}); }
  }
  history(): BrowserHistoryEntry[] { return this.visits.map(({ partition: _partition, ...entry }) => ({ ...entry })); }
  async clearHistory(): Promise<void> { this.visits = []; await this.persist(); }
  async clearData(): Promise<void> {
    // Include profiles used in earlier app sessions and Projects with no open tab.
    await Promise.all([...this.profiles].map(async partition => { const profile = session.fromPartition(partition); await Promise.all([profile.clearCache(), profile.clearStorageData(), profile.clearAuthCache()]); }));
    await this.clearHistory();
  }
  async flush(): Promise<void> { await this.queue; await Promise.all([...this.configured].map(partition => session.fromPartition(partition).cookies.flushStore())); }
}
