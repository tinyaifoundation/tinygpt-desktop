import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ManagedLocalModel, managedServerArgs } from '../src/main/managed-local';
import { inspectLocal, withModel } from '../src/core/inference-discovery';
import { defaultSettings } from '../src/shared/config';
import { contextPolicy } from '../src/core/context';
const folders: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(folders.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'tinygpt-model-')); folders.push(root); return { service: new ManagedLocalModel(root), file: join(root, 'test.gguf') }; }
const bytes = Buffer.from('a verified local model fixture');
const hash = createHash('sha256').update(bytes).digest('hex');
describe('managed MiniCPM runtime', () => {
  it('retains tool and context capabilities when the running server is rediscovered', async () => {
    const request = vi.fn<typeof fetch>(async url => new Response(JSON.stringify(String(url).endsWith('/v1/models') ? { data: [{ id: 'MiniCPM5-2B' }] } : String(url).endsWith('/props') ? { default_generation_settings: { n_ctx: 65536 }, chat_template_caps: { supports_tools: true, supports_tool_calls: true } } : {})));
    const found = await inspectLocal(defaultSettings, 'http://127.0.0.1:1234/v1', undefined, request);
    const settings = withModel(defaultSettings, 'local', found.models[0]);
    expect(settings.local.tools).toBe(true); expect(settings.local.contextWindowTokens).toBe(65536); expect(settings.local.maxOutputTokens).toBe(8192);
    const policy = contextPolicy({ route: 'local', ...settings.local });
    expect(policy.inputTokens).toBeGreaterThan(50000); expect(policy.inputTokens + policy.outputTokens).toBeLessThan(65536);
  });
  it('allocates the full context to one slot, preserves output space, and binds only loopback with authentication', () => {
    const args = managedServerArgs('model.gguf', 8123, 'server.key', 'CUDA');
    const value = (name: string) => args[args.indexOf(name) + 1];
    expect(value('--ctx-size')).toBe('65536'); expect(value('--parallel')).toBe('1'); expect(value('--n-predict')).toBe('8192');
    expect(value('--host')).toBe('127.0.0.1'); expect(value('--api-key-file')).toBe('server.key');
    expect(args).toContain('--no-context-shift'); expect(value('--min-p')).toBe('0.0');
    expect(value('--spec-type')).toBe('none'); expect(args).not.toContain('--model-draft');
    expect(managedServerArgs('m', 1, 'k', 'CUDA', true)).toContain('ngram-simple');
  });
  it('resumes partial downloads and verifies bytes before promoting the file', async () => {
    const { service, file } = await fixture(); await writeFile(file + '.partial', bytes.subarray(0, 5));
    const fetch = vi.fn(async (_url: string, options: RequestInit) => { expect(options.headers).toEqual({ Range: 'bytes=5-' }); return new Response(bytes.subarray(5), { status: 206, headers: { 'Content-Range': `bytes 5-${bytes.length - 1}/${bytes.length}` } }); });
    vi.stubGlobal('fetch', fetch);
    await service['download']('https://fixture.test/model', file, bytes.length, hash, new AbortController().signal, 'fixture');
    expect(await readFile(file)).toEqual(bytes);
    await service['download']('https://fixture.test/model', file, bytes.length, hash, new AbortController().signal, 'fixture');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('restarts safely when a server ignores Range', async () => {
    const { service, file } = await fixture(); await writeFile(file + '.partial', bytes.subarray(0, 5));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes)));
    await service['download']('https://fixture.test/model', file, bytes.length, hash, new AbortController().signal, 'fixture');
    expect(await readFile(file)).toEqual(bytes);
  });
  it('rejects corrupt downloads instead of executing or promoting them', async () => {
    const { service, file } = await fixture(); vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.alloc(bytes.length))));
    await expect(service['download']('https://fixture.test/model', file, bytes.length, hash, new AbortController().signal, 'fixture')).rejects.toThrow('checksum');
    await expect(readFile(file)).rejects.toThrow(); await expect(readFile(file + '.partial')).rejects.toThrow();
  });
  it('cancels without promoting partial files', async () => {
    const { service, file } = await fixture(); const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => { controller.abort(); return new Response(bytes); }));
    await expect(service['download']('https://fixture.test/model', file, bytes.length, hash, controller.signal, 'fixture')).rejects.toThrow();
    await expect(readFile(file)).rejects.toThrow();
  });
});
