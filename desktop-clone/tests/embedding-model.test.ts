import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyRagModel } from '../src/main/embedding-model';
import manifest from '../src/shared/rag-models.json';
const folders: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const path of folders.splice(0)) await rm(path, { recursive: true, force: true }); });
it('never downloads missing bundled models, even when network is available', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tinygpt-model-')); folders.push(root);
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(verifyRagModel(root, 'embedding')).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
});
it('detects same-sized tampered model files before any inference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tinygpt-model-')); folders.push(root); await mkdir(join(root, 'embedding'));
  await writeFile(join(root, 'embedding', 'config.json'), Buffer.alloc(manifest.embedding.files[0].size));
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(verifyRagModel(root, 'embedding')).rejects.toThrow('checksum mismatch'); expect(fetch).not.toHaveBeenCalled();
});
