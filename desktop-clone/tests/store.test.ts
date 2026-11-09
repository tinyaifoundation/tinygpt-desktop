import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { SettingsStore, type Encryption } from '../src/main/store';
import { defaultSettings, settingsSchema, toolPermissionsSchema } from '../src/shared/config';
import { connectionSettings } from '../src/shared/inference-connections';

const directories: string[] = [];
// Fake encryption tests the storage boundary only. OS encryption is smoke-tested
// in Electron and is never replaced by this codec in the actual application.
const codec: Encryption = {
  available: () => true,
  encrypt: value => Buffer.from([...value].reverse().join('')),
  decrypt: value => [...value.toString()].reverse().join(''),
};
async function setup(encryption = codec) {
  const directory = await mkdtemp(join(tmpdir(), 'tinygpt-test-'));
  directories.push(directory);
  const store = new SettingsStore(directory, encryption);
  await store.load();
  return { store, directory };
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => {
    const resolved = resolve(directory);
    if (dirname(resolved).toLowerCase() !== resolve(tmpdir()).toLowerCase()
      || !basename(resolved).startsWith('tinygpt-test-')) throw new Error('Refusing to remove an unexpected test directory.');
    return rm(resolved, { recursive: true, force: true });
  }));
});

describe('settings and credential persistence', () => {
  it('refreshes an idle owned server key/port without changing the active cloud connection', async () => {
    const { store, directory } = await setup();
    const local = await store.addInferenceConnection({ ...defaultSettings, local: { ...defaultSettings.local, model: 'owned-fixture' } }, 'local', 'old-key');
    const cloud = await store.addInferenceConnection(defaultSettings, 'byok', 'cloud-key');
    await store.refreshOwnedLocal(local, 'http://127.0.0.1:54321/v1', 'fresh-key');
    expect(store.activeConnectionId()).toBe(cloud); expect(store.getSettings().route).toBe('byok');
    expect(store.connectionSecret(local)).toBe('fresh-key'); expect(store.connectionSecret(cloud)).toBe('cloud-key');
    const restored = new SettingsStore(directory, codec); await restored.load();
    expect(restored.activeConnectionId()).toBe(cloud); expect(restored.connection(local).config.endpoint).toBe('http://127.0.0.1:54321/v1');
    await restored.activateInferenceConnection(local); expect(restored.getSecret('local')).toBe('fresh-key');
  });
  it('persists Pro acceleration outside the legacy settings schema', async () => {
    const { store, directory } = await setup();
    await store.saveSettings({ ...store.getSettings(), builtIn: { proMtp: false } });
    const disk = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'));
    expect(disk).not.toHaveProperty('builtIn');
    expect(JSON.parse(await readFile(join(directory, 'built-in-models.json'), 'utf8'))).toEqual({ proMtp: false });
    const reopened = new SettingsStore(directory, codec); await reopened.load();
    expect(reopened.getSettings().builtIn.proMtp).toBe(false);
    await writeFile(join(directory, 'built-in-models.json'), 'corrupt');
    const recovered = new SettingsStore(directory, codec); await recovered.load();
    expect(recovered.getSettings().builtIn.proMtp).toBe(false);
    expect(recovered.getSettings().route).toBe(defaultSettings.route);
  });
  it('persists desktop policy separately so the previous strict-schema branch can still load the same profile', async () => {
    const { store, directory } = await setup();
    const next = { ...store.getSettings(), computer: { enabled: false }, toolPermissions: { ...store.getSettings().toolPermissions, desktop: 'deny' as const, desktopInteract: 'allow' as const } };
    await store.saveSettings(next);
    const disk = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'));
    const legacySchema = settingsSchema.omit({ computer: true, builtIn: true }).extend({ toolPermissions: toolPermissionsSchema.omit({ desktop: true, desktopInteract: true }) });
    expect(legacySchema.safeParse(disk).success).toBe(true);
    expect(disk).not.toHaveProperty('computer'); expect(disk.toolPermissions).not.toHaveProperty('desktop');
    const reopened = new SettingsStore(directory, codec); await reopened.load();
    expect(reopened.getSettings().computer.enabled).toBe(false); expect(reopened.getSettings().toolPermissions.desktop).toBe('deny'); expect(reopened.getSettings().toolPermissions.desktopInteract).toBe('allow');
  });
  it('keeps normal chat settings available and disables desktop access if its optional policy is corrupt', async () => {
    const { store, directory } = await setup(); await store.saveSettings(defaultSettings);
    await writeFile(join(directory, 'computer-use.json'), 'corrupt');
    const reopened = new SettingsStore(directory, codec); await reopened.load();
    expect(reopened.getSettings().computer.enabled).toBe(false); expect(reopened.getSettings().route).toBe(defaultSettings.route);
  });
  it('keeps multiple providers, local servers, selections and encrypted keys across restarts', async () => {
    const { store, directory } = await setup();
    const first = await store.addInferenceConnection({ ...defaultSettings, byok: { ...defaultSettings.byok, model: 'openai-model' } }, 'byok', 'openai-secret');
    const local = await store.addInferenceConnection({ ...defaultSettings, local: { ...defaultSettings.local, model: 'local-model', contextWindowTokens: 32768, tools: true } }, 'local');
    const second = await store.addInferenceConnection({ ...defaultSettings, byok: { ...defaultSettings.byok, provider: 'anthropic', protocol: 'anthropic', endpoint: 'https://api.anthropic.com/v1', model: 'claude-model' } }, 'byok', 'anthropic-secret');
    expect(store.inferenceConnections()).toHaveLength(3);
    expect(store.getSecret('byok')).toBe('anthropic-secret');
    expect(store.connectionSecret(first)).toBe('openai-secret');
    await store.activateInferenceConnection(first); expect(store.getSettings().byok.model).toBe('openai-model'); expect(store.getSecret('byok')).toBe('openai-secret');
    await store.activateInferenceConnection(local); expect(store.getSettings().route).toBe('local'); expect(store.getSettings().local.contextWindowTokens).toBe(32768);
    await store.activateInferenceConnection(second);
    const next = new SettingsStore(directory, codec); await next.load();
    expect(next.activeConnectionId()).toBe(second); expect(next.getSecret('byok')).toBe('anthropic-secret'); expect(next.inferenceConnections()).toHaveLength(3);
    for (const filename of ['settings.json', 'inference-connections.json', 'credentials.json']) expect(await readFile(join(directory, filename), 'utf8')).not.toMatch(/openai-secret|anthropic-secret/);
    expect(JSON.stringify(next.inferenceConnections())).not.toMatch(/openai-secret|anthropic-secret/);
  });
  it('keeps separate keys for two accounts at the same provider and endpoint', async () => {
    const { store } = await setup();
    const first = await store.addInferenceConnection(defaultSettings, 'byok', 'first-account');
    const second = await store.addInferenceConnection(defaultSettings, 'byok', 'second-account');
    expect(store.connection(first).name).toBe('OpenAI'); expect(store.connection(second).name).toBe('OpenAI 2');
    await store.activateInferenceConnection(first); expect(store.getSecret('byok')).toBe('first-account');
    await store.activateInferenceConnection(second); expect(store.getSecret('byok')).toBe('second-account');
    await store.removeInferenceConnection(first); expect(store.getSecret('byok')).toBe('second-account'); expect(store.activeConnectionId()).toBe(second);
  });
  it('updates a model on its own connection and preserves the other saved selections', async () => {
    const { store } = await setup();
    const first = await store.addInferenceConnection(defaultSettings, 'byok', 'first-key');
    const second = await store.addInferenceConnection({ ...defaultSettings, byok: { ...defaultSettings.byok, model: 'second-model' } }, 'byok', 'second-key');
    const next = connectionSettings(store.getSettings(), store.connection(first)); next.byok.model = 'first-model'; next.byok.images = true;
    await store.activateInferenceConnection(first, next);
    expect(store.connection(first).config.model).toBe('first-model'); expect(store.connection(second).config.model).toBe('second-model'); expect(store.getSecret('byok')).toBe('first-key');
    await store.saveSettings({ ...store.getSettings(), byok: { ...store.getSettings().byok, model: 'first-new-model' } });
    expect(store.connection(first).config.model).toBe('first-new-model'); expect(store.connection(second).config.model).toBe('second-model');
  });
  it('keeps a delayed catalog refresh attached to its own account without changing the active source', async () => {
    const { store } = await setup();
    const configured = { ...defaultSettings, byok: { ...defaultSettings.byok, model: 'shared-model' } };
    const first = await store.addInferenceConnection(configured, 'byok', 'first-key'); const expected = store.connection(first);
    const second = await store.addInferenceConnection(configured, 'byok', 'second-key');
    await store.refreshInferenceCapabilities(expected, { id: 'shared-model', name: 'First account model', reasoning: { kind: 'none', efforts: [], canDisable: false } });
    expect(store.activeConnectionId()).toBe(second); expect(store.getSettings().byok.modelCapabilities).toBeUndefined(); expect(store.getSecret('byok')).toBe('second-key'); expect(store.connection(first).config.modelCapabilities?.name).toBe('First account model');
    await store.activateInferenceConnection(first); expect(store.getSettings().byok.modelCapabilities?.name).toBe('First account model');
    const stale = store.connection(first); await store.saveSettings({ ...store.getSettings(), byok: { ...store.getSettings().byok, model: 'different-model', modelCapabilities: undefined } });
    await store.refreshInferenceCapabilities(stale, { id: 'shared-model', name: 'Stale model', reasoning: { kind: 'none', efforts: [], canDisable: false } });
    expect(store.getSettings().byok.model).toBe('different-model'); expect(store.getSettings().byok.modelCapabilities).toBeUndefined();
  });
  it('removes only the requested connection and selects a remaining provider when active', async () => {
    const { store, directory } = await setup();
    const first = await store.addInferenceConnection({ ...defaultSettings, byok: { ...defaultSettings.byok, model: 'first-model' } }, 'byok', 'first-key');
    const second = await store.addInferenceConnection({ ...defaultSettings, byok: { ...defaultSettings.byok, provider: 'xai', endpoint: 'https://api.x.ai/v1', model: 'second-model' } }, 'byok', 'second-key');
    await store.removeInferenceConnection(second);
    expect(store.activeConnectionId()).toBe(first); expect(store.getSettings().byok.model).toBe('first-model'); expect(store.getSecret('byok')).toBe('first-key');
    expect(JSON.parse(await readFile(join(directory, 'credentials.json'), 'utf8'))[`connection:${second}`]).toBeUndefined();
    await store.removeInferenceConnection(first); expect(store.inferenceConnections()).toEqual([]); expect(store.getSecret('byok')).toBeUndefined(); expect(store.getSettings().byok.model).toBe('');
    const next = new SettingsStore(directory, codec); await next.load(); expect(next.inferenceConnections()).toEqual([]);
  });
  it('clears a disconnected local selection when falling back to a saved API provider', async () => {
    const { store } = await setup();
    const api = await store.addInferenceConnection({ ...defaultSettings, byok: { ...defaultSettings.byok, model: 'api-model' } }, 'byok', 'api-key');
    const local = await store.addInferenceConnection({ ...defaultSettings, local: { ...defaultSettings.local, model: 'local-model' } }, 'local');
    await store.removeInferenceConnection(local);
    expect(store.activeConnectionId()).toBe(api); expect(store.getSettings().local.model).toBe(''); expect(store.getSettings().byok.model).toBe('api-model'); expect(store.getSecret('byok')).toBe('api-key');
  });
  it('keeps multiple local endpoints and their credentials independent', async () => {
    const { store } = await setup();
    const first = await store.addInferenceConnection({ ...defaultSettings, local: { ...defaultSettings.local, model: 'shared-local', tools: true } }, 'local', 'local-first-key', undefined, 'Ollama');
    const second = await store.addInferenceConnection({ ...defaultSettings, local: { ...defaultSettings.local, endpoint: 'http://localhost:1234/v1', model: 'shared-local', images: true } }, 'local', 'local-second-key', undefined, 'LM Studio');
    await store.activateInferenceConnection(first); expect(store.getSecret('local')).toBe('local-first-key'); expect(store.getSettings().local.tools).toBe(true);
    await store.activateInferenceConnection(second); expect(store.getSecret('local')).toBe('local-second-key'); expect(store.getSettings().local.images).toBe(true);
    await store.removeInferenceConnection(second); expect(store.activeConnectionId()).toBe(first); expect(store.getSettings().local.endpoint).toBe(defaultSettings.local.endpoint); expect(store.getSecret('local')).toBe('local-first-key');
  });
  it('forgets the legacy credential alias when its migrated connection is removed', async () => {
    const { store, directory } = await setup(); await store.saveSettings(defaultSettings); await store.saveSecret('byok', 'legacy-key');
    const next = new SettingsStore(directory, codec); await next.load(); const legacy = next.inferenceConnections()[0].id;
    const added = await next.addInferenceConnection(defaultSettings, 'byok', 'new-key'); await next.removeInferenceConnection(legacy);
    const saved = JSON.parse(await readFile(join(directory, 'credentials.json'), 'utf8')); expect(saved.byok).toBeUndefined(); expect(saved[`connection:${legacy}`]).toBeUndefined(); expect(next.activeConnectionId()).toBe(added); expect(next.getSecret('byok')).toBe('new-key');
  });
  it('replaces a key in its tile without removing unrelated providers', async () => {
    const { store } = await setup();
    const first = await store.addInferenceConnection(defaultSettings, 'byok', 'old-key');
    const second = await store.addInferenceConnection(defaultSettings, 'byok', 'other-key');
    await store.addInferenceConnection(defaultSettings, 'byok', 'new-key', first);
    expect(store.inferenceConnections().map(item => item.id)).toEqual([first, second]); expect(store.connectionSecret(first)).toBe('new-key'); expect(store.connectionSecret(second)).toBe('other-key');
  });
  it('changes OpenRouter privacy and access without switching an active direct provider', async () => {
    const { store } = await setup();
    const router = await store.addInferenceConnection({ ...defaultSettings, openrouter: { ...defaultSettings.openrouter, access: 'paid' }, byok: { ...defaultSettings.byok, provider: 'openrouter', endpoint: 'https://openrouter.ai/api/v1', model: 'paid-model' } }, 'byok', 'router-key');
    const direct = await store.addInferenceConnection({ ...defaultSettings, byok: { ...defaultSettings.byok, model: 'direct-model' } }, 'byok', 'direct-key');
    await store.saveOpenRouterPreferences({ ...defaultSettings.openrouter, zeroDataRetention: true });
    expect(store.activeConnectionId()).toBe(direct); expect(store.getSettings().byok.model).toBe('direct-model'); expect(store.getSecret('byok')).toBe('direct-key'); expect(store.connection(router).config.model).toBe('openrouter/free'); expect(store.connectionSecret(router)).toBe('router-key');
    await store.activateInferenceConnection(router); expect(store.getSettings().openrouter.zeroDataRetention).toBe(true);
  });
  it('selects the matching router after connection and access changes, and persists cost tiers without resetting a manual model', async () => {
    const { store, directory } = await setup();
    const configured = { ...defaultSettings, byok: { ...defaultSettings.byok, provider: 'openrouter' as const, endpoint: 'https://openrouter.ai/api/v1' } };
    const id = await store.addInferenceConnection(configured, 'byok', 'router-key');
    expect(store.getSettings().byok).toMatchObject({ model: 'openrouter/free', tools: true, images: true, modelCapabilities: { name: 'Free Models Router' } });
    await store.saveOpenRouterPreferences({ ...store.getSettings().openrouter, access: 'paid' });
    expect(store.getSettings().byok.model).toBe('openrouter/auto-beta');
    await store.saveSettings({ ...store.getSettings(), byok: { ...store.getSettings().byok, model: 'manual-model', modelCapabilities: undefined } });
    await store.saveOpenRouterPreferences({ ...store.getSettings().openrouter, costTier: 'xhigh' });
    expect(store.getSettings().byok.model).toBe('manual-model');
    const next = new SettingsStore(directory, codec); await next.load();
    expect(next.getSettings().openrouter.costTier).toBe('xhigh'); expect(next.connection(id).config.model).toBe('manual-model');
    await next.saveOpenRouterPreferences({ ...next.getSettings().openrouter, access: 'free' });
    expect(next.getSettings().byok.model).toBe('openrouter/free'); expect(next.getSecret('byok')).toBe('router-key');
    await next.addInferenceConnection({ ...configured, openrouter: { ...configured.openrouter, access: 'paid', costTier: 'max' } }, 'byok', 'replacement-key', id);
    expect(next.getSettings().byok.model).toBe('openrouter/auto-beta'); expect(next.getSettings().openrouter.costTier).toBe('max');
  });
  it('changes the router access choice while keeping a local model active', async () => {
    const { store } = await setup();
    const router = await store.addInferenceConnection({ ...defaultSettings, byok: { ...defaultSettings.byok, provider: 'openrouter', endpoint: 'https://openrouter.ai/api/v1' } }, 'byok', 'router-key');
    const local = await store.addInferenceConnection({ ...defaultSettings, local: { ...defaultSettings.local, model: 'local-model' } }, 'local');
    await store.saveOpenRouterPreferences({ ...defaultSettings.openrouter, access: 'paid', costTier: 'high' });
    expect(store.activeConnectionId()).toBe(local); expect(store.getSettings().route).toBe('local'); expect(store.getSettings().local.model).toBe('local-model');
    expect(store.connection(router).config.model).toBe('openrouter/auto-beta');
  });
  it('migrates the existing provider and local model into individual connections', async () => {
    const { store, directory } = await setup();
    await store.saveSettings({ ...defaultSettings, route: 'byok', byok: { ...defaultSettings.byok, model: 'existing-model' }, local: { ...defaultSettings.local, model: 'existing-local' } });
    await store.saveSecret('byok', 'existing-key');
    const next = new SettingsStore(directory, codec); await next.load();
    expect(next.inferenceConnections()).toHaveLength(2); expect(next.getSecret('byok')).toBe('existing-key'); expect(next.getSettings().byok.model).toBe('existing-model');
    const id = next.activeConnectionId()!; await next.activateInferenceConnection(id); expect(next.getSecret('byok')).toBe('existing-key');
    const again = new SettingsStore(directory, codec); await again.load(); expect(again.activeConnectionId()).toBe(id); expect(again.inferenceConnections()).toHaveLength(2);
  });
  it('never sends a registered key to a changed endpoint, including after a partial disk write', async () => {
    const { store, directory } = await setup();
    const id = await store.addInferenceConnection(defaultSettings, 'byok', 'bound-key');
    const changed = { ...store.getSettings(), byok: { ...store.getSettings().byok, endpoint: 'https://different.example/v1' } };
    await writeFile(join(directory, 'settings.json'), JSON.stringify(changed));
    const next = new SettingsStore(directory, codec); await next.load(); expect(next.getSecret('byok')).toBeUndefined(); expect(next.secretStatus().byok).toBe(false); expect(next.activeConnectionId()).toBeUndefined();
    await next.activateInferenceConnection(id); expect(next.getSecret('byok')).toBe('bound-key'); expect(next.getSettings().byok.endpoint).toBe(defaultSettings.byok.endpoint);
  });
  it('rejects model activation against a different endpoint and preserves the current connection', async () => {
    const { store } = await setup(); const id = await store.addInferenceConnection(defaultSettings, 'byok', 'bound-key');
    await expect(store.activateInferenceConnection(id, { ...store.getSettings(), route: 'byok', byok: { ...defaultSettings.byok, endpoint: 'https://different.example/v1' } })).rejects.toThrow('Your connection changed');
    expect(store.getSecret('byok')).toBe('bound-key');
  });
  it('preserves the access choice implied by an existing billed OpenRouter connection', async () => {
    const { directory } = await setup(); const { openrouter, ...old } = defaultSettings;
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ ...old, byok: { ...old.byok, provider: 'openrouter', model: 'provider/paid' } }));
    const store = new SettingsStore(directory, codec); await store.load();
    expect(store.getSettings().openrouter.access).toBe('paid'); expect(store.getSettings().byok.model).toBe('provider/paid');
  });
  it('cannot attach a sign-in key to an endpoint changed concurrently by another window', async () => {
    const { store } = await setup();
    const openrouter = { ...defaultSettings, byok: { ...defaultSettings.byok, provider: 'openrouter' as const, endpoint: 'https://openrouter.ai/api/v1' } };
    await Promise.all([store.saveConnection(openrouter, 'byok', 'sign-in-key'), store.saveSettings({ ...defaultSettings, byok: { ...defaultSettings.byok, endpoint: 'https://other.example/v1' } })]);
    expect(store.getSettings().byok.endpoint).toBe('https://other.example/v1'); expect(store.getSecret('byok')).toBeUndefined();
  });
  it('round-trips settings and encrypted credentials across restarts', async () => {
    const { store, directory } = await setup();
    await store.saveSettings({ ...defaultSettings, mode: 'code' });
    await store.saveSecret('byok', 'test-secret');
    expect(await readFile(join(directory, 'settings.json'), 'utf8')).not.toContain('test-secret');
    expect(await readFile(join(directory, 'credentials.json'), 'utf8')).not.toContain('test-secret');
    const next = new SettingsStore(directory, codec); await next.load();
    expect(next.getSettings().mode).toBe('code');
    expect(next.getSecret('byok')).toBe('test-secret');
    expect(next.secretStatus().byok).toBe(true);
  });
  it('refuses to store plaintext when OS encryption is unavailable', async () => {
    const { store, directory } = await setup({ ...codec, available: () => false });
    await expect(store.saveSecret('byok', 'test-secret')).rejects.toThrow('Secure credential storage is unavailable.');
    expect(store.secretStatus().byok).toBe(false);
    await expect(readFile(join(directory, 'credentials.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('keeps concurrent credential updates instead of losing one', async () => {
    const { store } = await setup();
    await Promise.all([store.saveSecret('byok', 'first-key'), store.saveSecret('local', 'second-key')]);
    expect(store.secretStatus()).toEqual({ byok: true, local: true, portal: false });
  });
  it('invalidates a saved key when its endpoint changes', async () => {
    const { store } = await setup();
    await store.saveSecret('byok', 'first-provider-key');
    await store.saveSettings({ ...defaultSettings, byok: { ...defaultSettings.byok, endpoint: 'https://other.example.com/v1' } });
    expect(store.getSecret('byok')).toBeUndefined();
  });
  it('keeps a credential when only the selected model changes', async () => {
    const { store } = await setup();
    await store.saveSecret('byok', 'same-provider-key');
    await store.saveSettings({ ...defaultSettings, byok: { ...defaultSettings.byok, model: 'another-model' } });
    expect(store.getSecret('byok')).toBe('same-provider-key');
  });
  it('persists credential deletion', async () => {
    const { store, directory } = await setup();
    await store.saveSecret('byok', 'delete-me'); await store.deleteSecret('byok');
    const next = new SettingsStore(directory, codec); await next.load();
    expect(next.secretStatus().byok).toBe(false);
  });
  it('preserves a corrupt file instead of silently overwriting it', async () => {
    const { directory } = await setup();
    await writeFile(join(directory, 'settings.json'), 'corrupt');
    const next = new SettingsStore(directory, codec);
    await expect(next.load()).rejects.toThrow('Your files have been preserved.');
    expect(await readFile(join(directory, 'settings.json'), 'utf8')).toBe('corrupt');
  });
});
