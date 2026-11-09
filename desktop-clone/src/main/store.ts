import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultSettings, settingsSchema, type SecretSlot, type Settings } from '../shared/config';
import { connectionSettings, inferenceRegistrySchema, providerNames, type InferenceConnection, type InferenceRegistry } from '../shared/inference-connections';
import type { ModelInfo } from '../shared/effort';
import { withOpenRouterDefault } from '../shared/openrouter-routers';

export interface Encryption {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

export class SettingsStore {
  private settings: Settings = structuredClone(defaultSettings);
  private secrets: Record<string, string> = {};
  private registry: InferenceRegistry = { connections: [], selected: {} };
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private directory: string, private encryption: Encryption) {}

  async load(): Promise<void> {
    try {
      const saved: unknown = JSON.parse(await readFile(join(this.directory, 'settings.json'), 'utf8'));
      this.settings = settingsSchema.parse(saved);
      // Preserve an existing billed OpenRouter connection when loading settings
      // created before the user could choose free-only access.
      if (saved && typeof saved === 'object' && !('openrouter' in saved) && this.settings.byok.provider === 'openrouter' && this.settings.byok.model && !this.settings.byok.model.endsWith(':free') && this.settings.byok.model !== 'openrouter/free') this.settings.openrouter.access = 'paid';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Saved settings could not be read. Your files have been preserved.');
    }
    try {
      this.settings.builtIn = settingsSchema.shape.builtIn.parse(JSON.parse(await readFile(join(this.directory, 'built-in-models.json'), 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.settings.builtIn = { proMtp: false };
    }
    try { this.settings.modelResidency = settingsSchema.shape.modelResidency.parse(JSON.parse(await readFile(join(this.directory, 'model-residency.json'), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.settings.modelResidency = undefined; }
    // Keep the optional desktop policy outside the original v1 settings file.
    // The previous clone branch has a strict schema and must remain bootable.
    try {
      const policy = settingsSchema.pick({ computer: true, toolPermissions: true }).parse(JSON.parse(await readFile(join(this.directory, 'computer-use.json'), 'utf8')));
      this.settings.computer = policy.computer;
      this.settings.toolPermissions.desktop = policy.toolPermissions.desktop;
      this.settings.toolPermissions.desktopInteract = policy.toolPermissions.desktopInteract;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.settings.computer.enabled = false;
    }
    try {
      const saved: unknown = JSON.parse(await readFile(join(this.directory, 'credentials.json'), 'utf8'));
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Invalid credentials');
      for (const [slot, value] of Object.entries(saved)) {
        if (typeof value !== 'string') throw new Error('Invalid credentials');
        if (['byok', 'local', 'portal'].includes(slot) || /^connection:[0-9a-f-]{36}$/.test(slot)) this.secrets[slot] = value;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Saved credentials could not be read. Your files have been preserved.');
    }
    try {
      this.registry = inferenceRegistrySchema.parse(JSON.parse(await readFile(join(this.directory, 'inference-connections.json'), 'utf8')));
      if (new Set(this.registry.connections.map(item => item.id)).size !== this.registry.connections.length) throw new Error('Duplicate connection');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Saved connections could not be read. Your files have been preserved.');
      // Adopt the old single-provider settings without decrypting or exposing keys.
      for (const route of ['byok', 'local'] as const) {
        if (route === 'byok' ? !this.secrets.byok : !this.settings.local.model) continue;
        const id = randomUUID();
        const connection: InferenceConnection = route === 'byok'
          ? { id, route, name: providerNames[this.settings.byok.provider], config: this.settings.byok }
          : { id, route, name: 'Local Model', config: this.settings.local };
        this.registry.connections.push(connection); this.registry.selected[route] = id;
        if (this.secrets[route]) this.secrets[`connection:${id}`] = this.secrets[route];
      }
      if (this.registry.connections.length) {
        await this.atomicWrite('credentials.json', this.secrets);
        await this.atomicWrite('inference-connections.json', this.registry);
      }
    }
  }
  getSettings(): Settings { return structuredClone(this.settings); }
  private selectedConnection(route: 'byok' | 'local'): InferenceConnection | undefined {
    const connection = this.registry.connections.find(item => item.id === this.registry.selected[route] && item.route === route);
    const config = this.settings[route];
    return connection && config.endpoint === connection.config.endpoint && (connection.route === 'local' || route === 'byok' && this.settings.byok.provider === connection.config.provider && this.settings.byok.protocol === connection.config.protocol) ? connection : undefined;
  }
  inferenceConnections() {
    return structuredClone(this.registry.connections).map(item => ({ ...item, connected: item.route === 'local' || !!this.secrets[`connection:${item.id}`] }));
  }
  activeConnectionId(): string | undefined { return this.settings.route === 'portal' ? undefined : this.selectedConnection(this.settings.route)?.id; }
  connection(id: string): InferenceConnection {
    const connection = this.registry.connections.find(item => item.id === id);
    if (!connection) throw new Error('This connection is no longer available.');
    return structuredClone(connection);
  }
  private decrypt(encrypted: string | undefined): string | undefined {
    if (!encrypted) return undefined;
    if (!this.encryption.available()) throw new Error('Secure credential storage is unavailable.');
    return this.encryption.decrypt(Buffer.from(encrypted, 'base64'));
  }
  connectionSecret(id: string): string | undefined { this.connection(id); return this.decrypt(this.secrets[`connection:${id}`]); }
  secretStatus(): Record<SecretSlot, boolean> {
    const present = (slot: SecretSlot) => !!(slot !== 'portal' && this.registry.selected[slot] ? this.selectedConnection(slot) && this.secrets[`connection:${this.registry.selected[slot]}`] : this.secrets[slot]);
    return { byok: present('byok'), local: present('local'), portal: present('portal') };
  }
  secureStorageAvailable(): boolean { return this.encryption.available(); }
  getSecret(slot: SecretSlot): string | undefined {
    const id = slot === 'portal' ? undefined : this.registry.selected[slot];
    return this.decrypt(id ? slot !== 'portal' && this.selectedConnection(slot) ? this.secrets[`connection:${id}`] : undefined : this.secrets[slot]);
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => undefined);
    return next;
  }
  private async atomicWrite(filename: string, value: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temporary = join(this.directory, `${filename}.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(temporary, join(this.directory, filename));
  }
  saveSettings(value: Settings): Promise<void> {
    const validated = settingsSchema.parse(value);
    return this.enqueue(() => this.persistSettings(validated));
  }
  /** Keep the endpoint change and credential write in one queue operation so
   * another window cannot attach the new key to a different provider. */
  async saveConnection(value: Settings, slot: SecretSlot, secret: string): Promise<void> {
    const validated = settingsSchema.parse(value);
    if (!this.encryption.available()) throw new Error('Secure credential storage is unavailable.');
    const encrypted = this.encryption.encrypt(secret).toString('base64');
    return this.enqueue(async () => {
      await this.persistSettings(validated);
      const next = { ...this.secrets, [slot]: encrypted };
      const id = slot === 'portal' ? undefined : this.selectedConnection(slot)?.id;
      if (id) next[`connection:${id}`] = encrypted;
      await this.atomicWrite('credentials.json', next); this.secrets = next;
    });
  }
  private async persistSettings(validated: Settings): Promise<void> {
      const nextSecrets = { ...this.secrets };
      if (validated.byok.endpoint !== this.settings.byok.endpoint
        || validated.byok.provider !== this.settings.byok.provider
        || validated.byok.protocol !== this.settings.byok.protocol) delete nextSecrets.byok;
      if (validated.local.endpoint !== this.settings.local.endpoint) delete nextSecrets.local;
      if (validated.portal.endpoint !== this.settings.portal.endpoint) delete nextSecrets.portal;
      // Invalidate first so a failed settings write never leaves a credential
      // attached to a different endpoint. A key may need to be re-entered.
      if (JSON.stringify(nextSecrets) !== JSON.stringify(this.secrets)) {
        await this.atomicWrite('credentials.json', nextSecrets);
        this.secrets = nextSecrets;
      }
      const { computer, builtIn, modelResidency, ...legacy } = validated;
      const { desktop, desktopInteract, ...legacyPermissions } = legacy.toolPermissions;
      await this.atomicWrite('computer-use.json', { computer, toolPermissions: { desktop, desktopInteract } });
      await this.atomicWrite('built-in-models.json', builtIn);
      await this.atomicWrite('model-residency.json', modelResidency ?? { keepLoaded: false, idleMinutes: 10 });
      await this.atomicWrite('settings.json', { ...legacy, toolPermissions: legacyPermissions });
      this.settings = validated;
      for (const route of ['byok', 'local'] as const) {
        const id = this.registry.selected[route];
        const index = this.registry.connections.findIndex(item => item.id === id);
        if (index < 0) continue;
        const connection = this.registry.connections[index];
        const config = validated[route];
        const same = config.endpoint === connection.config.endpoint && (connection.route === 'local' || route === 'byok' && validated.byok.provider === connection.config.provider && validated.byok.protocol === connection.config.protocol);
        if (same) this.registry.connections[index] = { ...connection, config } as InferenceConnection;
        else delete this.registry.selected[route];
      }
      if (this.registry.connections.length) await this.atomicWrite('inference-connections.json', this.registry);
  }
  /** Each saved connection owns a separate encrypted key. Active settings are
   * a projection for the existing chat/code/bot runtimes, never a replacement. */
  addInferenceConnection(value: Settings, route: 'byok' | 'local', secret?: string, replaceId?: string, name?: string): Promise<string> {
    const validated = settingsSchema.parse(value);
    if (route === 'byok' && validated.byok.provider === 'openrouter' && !validated.byok.model) validated.byok = withOpenRouterDefault(validated.byok, validated.openrouter);
    const encrypted = secret === undefined ? undefined : (() => {
      if (!this.encryption.available()) throw new Error('Secure credential storage is unavailable.');
      return this.encryption.encrypt(secret).toString('base64');
    })();
    return this.enqueue(async () => {
      if (replaceId && this.connection(replaceId).route !== route) throw new Error('This connection changed. Open it again.');
      if (!replaceId && this.registry.connections.length >= 100) throw new Error('Remove a connection before adding another.');
      const id = replaceId ?? randomUUID();
      const previous = replaceId ? this.connection(replaceId) : undefined;
      const baseName = name ?? (route === 'byok' ? providerNames[validated.byok.provider] : 'Local Model');
      const used = new Set(this.registry.connections.filter(item => item.id !== id).map(item => item.name));
      let connectionName = previous?.name ?? baseName;
      if (!previous || previous.route === 'byok' && route === 'byok' && previous.config.provider !== validated.byok.provider) {
        connectionName = baseName;
        for (let suffix = 2; used.has(connectionName); suffix++) connectionName = `${baseName} ${suffix}`;
      }
      const connection: InferenceConnection = route === 'byok'
        ? { id, route, name: connectionName, config: validated.byok }
        : { id, route, name: connectionName, config: validated.local };
      const nextSecrets = { ...this.secrets };
      if (encrypted) nextSecrets[`connection:${id}`] = encrypted;
      else if (!previous || previous.config.endpoint !== connection.config.endpoint) delete nextSecrets[`connection:${id}`];
      // Write only encrypted credentials before exposing the new connection.
      await this.atomicWrite('credentials.json', nextSecrets); this.secrets = nextSecrets;
      const connections = [...this.registry.connections];
      const index = connections.findIndex(item => item.id === id);
      if (index < 0) connections.push(connection); else connections[index] = connection;
      this.registry = { connections, selected: { ...this.registry.selected, [route]: id } };
      await this.persistSettings({ ...this.settings, route, [route]: validated[route], openrouter: route === 'byok' && validated.byok.provider === 'openrouter' ? validated.openrouter : this.settings.openrouter });
      return id;
    });
  }
  activateInferenceConnection(id: string, value?: Settings): Promise<void> {
    return this.enqueue(async () => {
      const connection = this.connection(id);
      if (connection.route === 'byok' && !this.secrets[`connection:${id}`]) throw new Error('Reconnect this provider first.');
      if (value && (value.route !== connection.route || value[connection.route].endpoint !== connection.config.endpoint || connection.route === 'byok' && (value.byok.provider !== connection.config.provider || value.byok.protocol !== connection.config.protocol))) throw new Error('Your connection changed. Choose the model again.');
      this.registry.selected[connection.route] = id;
      await this.persistSettings(value ? settingsSchema.parse({ ...this.settings, route: connection.route, [connection.route]: value[connection.route] }) : connectionSettings(this.settings, connection));
    });
  }
  refreshOwnedLocal(id: string, endpoint: string, secret: string): Promise<void> {
    if (!this.encryption.available()) throw Error('Secure credential storage is unavailable.');
    const encrypted = this.encryption.encrypt(secret).toString('base64');
    return this.enqueue(async () => {
      const previous = this.connection(id); if (previous.route !== 'local') throw Error('Local connection unavailable.');
      const config = settingsSchema.shape.local.parse({ ...previous.config, endpoint });
      const secrets = { ...this.secrets, [`connection:${id}`]: encrypted };
      await this.atomicWrite('credentials.json', secrets); this.secrets = secrets;
      this.registry.connections = this.registry.connections.map(connection => connection.id === id ? { ...previous, config } : connection);
      if (this.registry.selected.local === id) await this.persistSettings({ ...this.settings, local: config });
      else await this.atomicWrite('inference-connections.json', this.registry);
    });
  }
  refreshInferenceCapabilities(expected: InferenceConnection, model: ModelInfo): Promise<boolean> {
    return this.enqueue(async () => {
      const index = this.registry.connections.findIndex(item => item.id === expected.id);
      const connection = this.registry.connections[index];
      if (!connection || JSON.stringify(connection) !== JSON.stringify(expected) || model.id !== connection.config.model || !model.reasoning) return false;
      const config = { ...connection.config, modelCapabilities: { model: model.id, name: model.name ?? connection.config.modelCapabilities?.name, images: model.images ?? connection.config.modelCapabilities?.images, reasoning: model.reasoning } };
      if (JSON.stringify(config) === JSON.stringify(connection.config)) return false;
      this.registry.connections[index] = { ...connection, config } as InferenceConnection;
      // Refresh this source only; a delayed catalog cannot switch providers or
      // overwrite the model/capabilities of another account at the same URL.
      if (this.selectedConnection(connection.route)?.id === connection.id && this.settings[connection.route].model === model.id) await this.persistSettings({ ...this.settings, [connection.route]: config });
      else await this.atomicWrite('inference-connections.json', this.registry);
      return true;
    });
  }
  saveOpenRouterPreferences(policy: Settings['openrouter']): Promise<void> {
    return this.enqueue(async () => {
      const changed = policy.access !== this.settings.openrouter.access;
      const selectDefault = (config: Settings['byok']) => changed || !config.model ? withOpenRouterDefault(config, policy) : config;
      this.registry.connections = this.registry.connections.map(item => item.route === 'byok' && item.config.provider === 'openrouter' ? { ...item, config: selectDefault(item.config) } : item);
      await this.persistSettings(settingsSchema.parse({ ...this.settings, openrouter: policy, byok: this.settings.byok.provider === 'openrouter' ? selectDefault(this.settings.byok) : this.settings.byok }));
    });
  }
  removeInferenceConnection(id: string): Promise<void> {
    return this.enqueue(async () => {
      const connection = this.connection(id);
      const nextSecrets = { ...this.secrets }; delete nextSecrets[`connection:${id}`];
      const selected = this.registry.selected[connection.route] === id;
      if (selected || this.secrets[connection.route] === this.secrets[`connection:${id}`]) delete nextSecrets[connection.route];
      await this.atomicWrite('credentials.json', nextSecrets); this.secrets = nextSecrets;
      this.registry.connections = this.registry.connections.filter(item => item.id !== id);
      if (selected) {
        delete this.registry.selected[connection.route];
        const remaining = this.registry.connections.filter(item => item.route === 'local' || this.secrets[`connection:${item.id}`]);
        const fallback = remaining.find(item => item.route === connection.route && item.config.model) ?? remaining.find(item => item.config.model) ?? remaining.find(item => item.route === connection.route) ?? remaining[0];
        let next = { ...this.settings, [connection.route]: { ...this.settings[connection.route], model: '', modelCapabilities: undefined, reasoningOverride: undefined, contextWindowTokens: undefined, maxOutputTokens: undefined, tools: false, images: false } };
        if (fallback && this.settings.route === connection.route) {
          this.registry.selected[fallback.route] = fallback.id; next = connectionSettings(next, fallback);
        }
        await this.persistSettings(next);
      }
      await this.atomicWrite('inference-connections.json', this.registry);
    });
  }
  saveSecret(slot: SecretSlot, value: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.encryption.available()) throw new Error('Secure credential storage is unavailable.');
      const next = { ...this.secrets, [slot]: this.encryption.encrypt(value).toString('base64') };
      const id = slot === 'portal' ? undefined : this.registry.selected[slot];
      if (id) next[`connection:${id}`] = next[slot];
      await this.atomicWrite('credentials.json', next);
      this.secrets = next;
    });
  }
  deleteSecret(slot: SecretSlot): Promise<void> {
    return this.enqueue(async () => {
      const next = { ...this.secrets };
      delete next[slot];
      const id = slot === 'portal' ? undefined : this.registry.selected[slot];
      if (id) delete next[`connection:${id}`];
      await this.atomicWrite('credentials.json', next);
      this.secrets = next;
    });
  }
}
