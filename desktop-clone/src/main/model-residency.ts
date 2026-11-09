export type ResidencyPolicy = { keepLoaded?: boolean; idleMinutes?: number };
type OwnedModel = { loaded(): boolean; busy(): boolean; unload(): Promise<void> };

/** Shared activity clock for owned servers. Remote connections alone are not activity. */
export class ModelResidency {
  private used = new Map<string, number>();
  private unloading = new Map<string, Promise<void>>();
  constructor(private models: Record<string, OwnedModel>, private policy: () => ResidencyPolicy, private now = Date.now) {}
  touch(id: string) { this.used.set(id, this.now()); }
  async ready(id: string) { await this.unloading.get(id); this.touch(id); }
  async tick() {
    const policy = this.policy();
    for (const [id, model] of Object.entries(this.models)) {
      if (!model.loaded()) { this.used.delete(id); continue; }
      if (policy.keepLoaded || model.busy()) { this.touch(id); continue; }
      if (!this.used.has(id)) this.touch(id);
      if (this.now() - this.used.get(id)! < (policy.idleMinutes ?? 10) * 60000 || this.unloading.has(id)) continue;
      const task = model.unload().finally(() => { this.unloading.delete(id); this.used.delete(id); });
      this.unloading.set(id, task); await task;
    }
  }
}
