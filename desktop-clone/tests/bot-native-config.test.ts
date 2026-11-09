import { it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { defaultBotConfiguration } from '../src/shared/bot';
import { nativeBotConfig, syncBotIdentity } from '../src/main/bot-native-config';
const managed = { gateway: { auth: { token: 'fresh-private-capability' } }, agents: { defaults: { model: { primary: 'tinygpt/fixture' }, modelPolicy: { allow: ['tinygpt/fixture'] } } }, models: { providers: { tinygpt: { apiKey: 'private-proxy' } } } };
it('adds the bridge to full native tools without replacing persona or unrelated native preferences', () => {
  const previous = { gateway: { auth: { token: 'stale' } }, agents: { entries: { main: { identity: { name: 'Old', emoji: '🌙' }, instructions: 'Keep my persona' }, helper: { name: 'Researcher' } }, defaults: { models: { legacy: {} }, memorySearch: {} } }, tools: { allow: ['tinygpt_action'], deny: ['*', 'gateway', 'cron', 'message'], loopDetection: { enabled: true } }, plugins: { entries: { custom: { config: { retain: true } } } } };
  const value = JSON.parse(JSON.stringify(nativeBotConfig(previous, managed, '/profile', '/runtime', 'Milo', defaultBotConfiguration)));
  expect(value.tools.profile).toBe('full'); expect(value.tools.allow).toBeUndefined(); expect(value.tools.alsoAllow).toContain('tinygpt_action'); expect(value.tools.deny).not.toContain('*'); expect(value.tools.deny).toContain('message'); expect(value.tools.exec.mode).toBe('ask'); expect(value.tools.fs.workspaceOnly).toBe(true);
  expect(value.agents.entries.main.identity).toEqual({ name: 'Milo', emoji: '🌙' }); expect(value.agents.entries.main.instructions).toBe('Keep my persona'); expect(value.agents.entries.helper.name).toBe('Researcher'); expect(value.agents.defaults.models).toBeUndefined(); expect(value.agents.defaults.memorySearch).toBeUndefined(); expect(value.gateway.auth.token).toBe('fresh-private-capability'); expect(value.plugins.entries.custom.config.retain).toBe(true);
});
it('re-enables cron and memory from previously disabled managed preferences', () => {
  const disabled = nativeBotConfig({}, managed, '/profile', '/runtime', 'Milo', { ...defaultBotConfiguration, memory: false });
  const enabled = nativeBotConfig(disabled, managed, '/profile', '/runtime', 'Milo', { ...defaultBotConfiguration, background: true, browser: true, files: 'computer', commands: 'deny' });
  expect(enabled.cron.enabled).toBe(true); expect(enabled.tools.deny).not.toContain('cron'); expect(enabled.plugins.slots.memory).toBe('memory-core'); expect(enabled.memory.search.enabled).toBe(true); expect(enabled.browser.enabled).toBe(true); expect(enabled.tools.fs.workspaceOnly).toBe(false); expect(enabled.tools.exec.mode).toBe('deny'); expect(enabled.agents.defaults.heartbeat.every).toBe('0m');
});
it('updates the model-facing name while preserving the user’s other identity and instructions', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'tinygpt-native-identity-'));
  try { await mkdir(join(profile, 'workspace')); await writeFile(join(profile, 'workspace/IDENTITY.md'), '# Identity\n- **Name:** Old\n- **Vibe:** Quiet and careful\n'); await writeFile(join(profile, 'workspace/SOUL.md'), 'User personality'); await syncBotIdentity(profile, 'Milo'); await syncBotIdentity(profile, 'Nova'); expect(await readFile(join(profile, 'workspace/IDENTITY.md'), 'utf8')).toBe('# Identity\n- **Name:** Nova\n- **Vibe:** Quiet and careful\n'); expect(await readFile(join(profile, 'workspace/SOUL.md'), 'utf8')).toBe('User personality'); } finally { const target = resolve(profile); if (dirname(target).toLowerCase() !== resolve(tmpdir()).toLowerCase() || !basename(target).startsWith('tinygpt-native-identity-')) throw Error('Unexpected test directory.'); await rm(target, { recursive: true, force: true }); }
});
