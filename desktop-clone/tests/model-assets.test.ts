import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { ModelAssets } from '../src/main/model-assets';
import { modelAssetsSchema } from '../src/shared/model-assets';
const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
async function setup(data = 'model content') {
  const root = await mkdtemp(join(tmpdir(), 'tinygpt-assets-')); folders.push(root);
  const resources = join(root, 'resources'), storage = join(root, 'storage');
  const asset = { path: 'voice-runtime/models/test.gguf', bytes: Buffer.byteLength(data), sha256: createHash('sha256').update(data).digest('hex') };
  const catalog = { version: 1 as const, files: [asset] };
  await mkdir(join(resources, 'voice-runtime/models'), { recursive: true }); await mkdir(join(resources, 'voice-runtime/llama'), { recursive: true });
  await writeFile(join(resources, 'voice-runtime/llama/llama-server.exe'), 'runtime-v1');
  return { root, resources, storage, asset, catalog, data };
}
it('reuses verified bundled models offline and keeps them across application versions', async () => {
  const { resources, storage, catalog, data } = await setup(); await writeFile(join(resources, catalog.files[0].path), data);
  const request = vi.fn<typeof fetch>(); const store = new ModelAssets(storage, resources, request);
  const first = await store.prepare(catalog, '0.1.0-prebeta.3', new AbortController().signal, vi.fn());
  await rm(join(resources, catalog.files[0].path)); await writeFile(join(resources, 'voice-runtime/llama/llama-server.exe'), 'runtime-v2');
  const next = await store.prepare(catalog, '0.1.0-prebeta.4', new AbortController().signal, vi.fn());
  expect(await readFile(join(first, catalog.files[0].path), 'utf8')).toBe(data); expect(await readFile(join(next, catalog.files[0].path), 'utf8')).toBe(data);
  expect(await readFile(join(next, 'voice-runtime/llama/llama-server.exe'), 'utf8')).toBe('runtime-v2'); expect(request).not.toHaveBeenCalled();
});
it('resumes a partial model download and rejects mismatched bytes before use', async () => {
  const { resources, storage, catalog, asset, data } = await setup(); await mkdir(join(storage, 'objects'), { recursive: true });
  await writeFile(join(storage, 'objects', asset.sha256 + '.part'), data.slice(0, 4));
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(data.slice(4), { status: 206, headers: { 'Content-Range': `bytes 4-${asset.bytes - 1}/${asset.bytes}` } }));
  const view = await new ModelAssets(storage, resources, request).prepare(catalog, '3', new AbortController().signal, vi.fn());
  expect(request.mock.calls[0][1]?.headers).toEqual({ Range: 'bytes=4-' }); expect(await readFile(join(view, asset.path), 'utf8')).toBe(data);
  await writeFile(join(storage, 'objects', asset.sha256), 'corrupt');
  request.mockResolvedValue(new Response('wrong model'));
  await expect(new ModelAssets(storage, resources, request).prepare(catalog, '4', new AbortController().signal, vi.fn())).rejects.toThrow(/checksum|expected size/);
  expect(await stat(join(storage, 'objects', asset.sha256)).catch(() => null)).toBeNull();
});
it('ignores a server that does not resume and validates the complete replacement', async () => {
  const { resources, storage, catalog, asset, data } = await setup(); await mkdir(join(storage, 'objects'), { recursive: true }); await writeFile(join(storage, 'objects', asset.sha256 + '.part'), 'old');
  const view = await new ModelAssets(storage, resources, vi.fn<typeof fetch>().mockResolvedValue(new Response(data))).prepare(catalog, '3', new AbortController().signal, vi.fn());
  expect(await readFile(join(view, asset.path), 'utf8')).toBe(data);
  expect(modelAssetsSchema.safeParse({ version: 1, files: [{ ...asset, path: 'voice-runtime/../../private' }] }).success).toBe(false);
  expect(modelAssetsSchema.safeParse({ version: 1, files: [asset, asset] }).success).toBe(false);
});
it('the installer migrates matching old model files without modifying the previous installation', async () => {
  const { root, resources, storage, asset, catalog, data } = await setup(); await writeFile(join(resources, asset.path), data);
  const path = join(root, 'catalog.json'); await writeFile(path, JSON.stringify(catalog));
  const { migrate } = createRequire(import.meta.url)('../scripts/migrate-model-assets.cjs');
  await migrate(resources, storage, path);
  expect(await readFile(join(storage, 'objects', asset.sha256), 'utf8')).toBe(data); expect(await readFile(join(resources, asset.path), 'utf8')).toBe(data);
});
