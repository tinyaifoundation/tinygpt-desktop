import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
const files = vi.hoisted(() => new Map<string, number>());
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>(), stat: vi.fn(async (path: string) => {
  const size = files.get(String(path)); if (size === undefined) throw Error('File missing'); return { size, isFile: () => true };
}) }));
import { ManagedLocalModel, managedLocalPins } from '../src/main/managed-local';
afterEach(() => { files.clear(); });

describe('complete built-in installation', () => {
  it('requires the runtime as well as weights for the included model', async () => {
    const model = new ManagedLocalModel('profile', 'bundle');
    files.set(join('bundle', 'models', 'MiniCPM5-2B-Q4_K_M.gguf'), managedLocalPins.model.size);
    expect(await model.installedStatus()).toMatchObject({ installed: true, ready: false });
    const runtimeFiles = process.platform === 'win32' ? ['llama-server.exe', 'llama-server-impl.dll', 'llama.dll', 'ggml.dll', 'ggml-base.dll', 'ggml-vulkan.dll'] : ['llama-server'];
    for (const file of runtimeFiles) files.set(join('bundle', 'llama', file), 100);
    expect(await model.installedStatus()).toMatchObject({ installed: true, ready: true });
    files.delete(join('bundle', 'llama', runtimeFiles[0]));
    expect(await model.installedStatus()).toMatchObject({ installed: true, ready: false });
  });
  it('requires Pro image support and all restart archives before showing Ready', async () => {
    const model = new ManagedLocalModel('pro', undefined, 'pro', 'runtime');
    files.set(join('pro', new URL(managedLocalPins.pro.url).pathname.split('/').at(-1)!), managedLocalPins.pro.size);
    const runtimeFiles = process.platform === 'win32' ? ['llama-server.exe', 'llama-server-impl.dll', 'llama.dll', 'ggml.dll', 'ggml-base.dll', 'ggml-cuda.dll'] : ['llama-server'];
    for (const file of runtimeFiles) files.set(join('runtime', 'llama-b11960-CUDA', file), 100);
    for (const archive of managedLocalPins.CUDA) files.set(join('runtime', archive.name), archive.size);
    expect(await model.installedStatus()).toMatchObject({ installed: true, ready: false });
    files.set(join('pro', new URL(managedLocalPins.proVision.url).pathname.split('/').at(-1)!), managedLocalPins.proVision.size);
    expect(await model.installedStatus()).toMatchObject({ installed: true, ready: true });
    expect(await model.installedStatus(true)).toMatchObject({ installed: true, ready: false });
    files.set(join('pro', new URL(managedLocalPins.proMtp.url).pathname.split('/').at(-1)!), managedLocalPins.proMtp.size);
    expect(await model.installedStatus(true)).toMatchObject({ installed: true, ready: true });
    files.set(join('runtime', managedLocalPins.CUDA[0].name), 0);
    expect(await model.installedStatus()).toMatchObject({ installed: true, ready: false });
  });
});
