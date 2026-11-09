import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/tinygpt' } }));
import { openClawEnvironment, openClawRuntimeDirectory, OpenClawRuntime, OPENCLAW_RUNTIME_ERROR } from '../src/main/openclaw-runtime';

const temporary: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
describe('private OpenClaw runtime boundaries', () => {
  it('isolates state and avoids inheriting credentials, proxies, preload hooks or user PATH', () => {
    for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'HTTP_PROXY', 'NODE_OPTIONS', 'OPENCLAW_GATEWAY_TOKEN', 'ELECTRON_RUN_AS_NODE', 'PATH']) vi.stubEnv(key, 'private-sentinel');
    const profile = join(tmpdir(), 'private bot profile');
    const env = openClawEnvironment(profile, 12345);
    expect(Object.values(env)).not.toContain('private-sentinel');
    expect(env.OPENCLAW_STATE_DIR).toBe(join(profile, 'state'));
    expect(env.HOME).toBe(profile); expect(env.USERPROFILE).toBe(profile);
    expect(env.OPENCLAW_CONFIG_PATH).toBe(join(profile, 'openclaw.json'));
    expect(env.OPENCLAW_NO_RESPAWN).toBe('1'); expect(env.OPENCLAW_EXEC_SHELL_SNAPSHOT).toBe('0');
    expect(env.OPENCLAW_DISABLE_BONJOUR).toBe('1'); expect(env.OPENCLAW_SKIP_CHANNELS).toBe('1');
    expect(env.OPENCLAW_GATEWAY_PORT).toBe('12345');
    expect(env.NODE_DISABLE_COMPILE_CACHE).toBe('1');
  });
  it('resolves a project resource rather than a PATH-installed gateway', () => {
    expect(openClawRuntimeDirectory()).toBe(join('/tinygpt', 'runtimes', 'openclaw'));
  });
  it('rejects mismatched prepared runtime versions before creating any child', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openclaw-resource-')); temporary.push(root);
    await writeFile(join(root, 'prepared.json'), JSON.stringify({ openclaw: 'different', target: `${process.platform}-${process.arch}` }));
    await expect(OpenClawRuntime.start({ profileDirectory: join(root, 'profile'), runtimeDirectory: root })).rejects.toThrow(OPENCLAW_RUNTIME_ERROR);
  });
  it('rejects nonlocal inference fixtures before writing provider configuration or launching a child', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openclaw-resource-')); temporary.push(root);
    await writeFile(join(root, 'prepared.json'), JSON.stringify({ openclaw: '2026.9.9', node: '24.19.0', target: `${process.platform}-${process.arch}` }));
    const executable = join(root, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
    await mkdir(join(root, 'node', 'bin'), { recursive: true }); await writeFile(executable, 'fixture');
    await expect(OpenClawRuntime.start({ profileDirectory: join(root, 'profile'), runtimeDirectory: root, fixtureEndpoint: 'https://provider.example/v1' })).rejects.toThrow('loopback fixture');
  });
});
