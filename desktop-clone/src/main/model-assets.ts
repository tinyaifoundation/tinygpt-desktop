import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat, lstat, readFile, readdir, copyFile, link, rename, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { modelAssetsSchema, type ModelAsset, type ModelAssets as ModelCatalog } from '../shared/model-assets';

export type AssetProgress = { completed: number; total: number; bytes: number; totalBytes: number; downloading: boolean };
const groups = ['voice-runtime', 'rag', 'vision'] as const;
const modelExtension = /\.(?:gguf|onnx|ort|safetensors|bin)$/i;
async function regular(path: string) { const file = await lstat(path).catch(() => null); return file?.isFile() && !file.isSymbolicLink() ? file : null; }
async function verified(path: string, asset: ModelAsset) {
  if ((await regular(path))?.size !== asset.bytes) return false;
  const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex') === asset.sha256;
}
async function removeFile(path: string) { await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
async function localDirectory(root: string, parts: string[] = []) {
  await mkdir(root, { recursive: true });
  let path = root;
  for (const part of ['', ...parts]) {
    if (part) { path = join(path, part); await mkdir(path).catch(error => { if (error.code !== 'EEXIST') throw error; }); }
    const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Model storage must use local directories.');
  }
  return path;
}

/** A release-pinned model catalog, with verified objects shared across application versions. */
export class ModelAssets {
  constructor(private root: string, private resources: string, private request: typeof fetch = fetch) {}
  private async download(asset: ModelAsset, destination: string, signal: AbortSignal, progress: (bytes: number) => void) {
    const partial = destination + '.part';
    if ((await lstat(partial).catch(() => null))?.isSymbolicLink()) throw Error('Unexpected link in model storage.');
    let offset = (await regular(partial))?.size ?? 0;
    if (offset >= asset.bytes) { await removeFile(partial); offset = 0; }
    const response = await this.request(`https://downloads.tinygpt.org/assets/sha256/${asset.sha256}`, { headers: offset ? { Range: `bytes=${offset}-` } : {}, signal, redirect: 'error' });
    if (!response.ok || !response.body) throw Error('Model download could not finish. Check your connection and try again.');
    if (offset && response.status === 206) {
      if (response.headers.get('content-range') !== `bytes ${offset}-${asset.bytes - 1}/${asset.bytes}`) throw Error('Model download range could not be verified.');
    } else if (response.status === 200) offset = 0;
    else throw Error('Model download response could not be verified.');
    let received = offset;
    const source = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>);
    source.on('data', chunk => { received += chunk.length; if (received > asset.bytes) source.destroy(Error('Model download exceeded its expected size.')); else progress(received); });
    await pipeline(source, createWriteStream(partial, { flags: offset ? 'a' : 'w' }), { signal });
    if (!(await verified(partial, asset))) { await removeFile(partial); throw Error('Model download checksum did not match. Please try again.'); }
    await rename(partial, destination);
  }
  async prepare(catalog: ModelCatalog, version: string, signal: AbortSignal, changed: (state: AssetProgress) => void): Promise<string> {
    const model = modelAssetsSchema.parse(catalog);
    if (!/^[A-Za-z0-9.-]+$/.test(version)) throw Error('Invalid application asset version.');
    await localDirectory(this.root, ['objects']);
    const catalogId = createHash('sha256').update(JSON.stringify(model)).digest('hex').slice(0, 20);
    const view = await localDirectory(this.root, ['versions', `${version}-${catalogId}`]);
    const state: AssetProgress = { completed: 0, total: model.files.length, bytes: 0, totalBytes: model.files.reduce((sum, file) => sum + file.bytes, 0), downloading: false };
    for (const asset of model.files) {
      signal.throwIfAborted();
      const object = join(this.root, 'objects', asset.sha256);
      if (!(await verified(object, asset))) {
        await removeFile(object);
        const bundled = join(this.resources, ...asset.path.split('/'));
        if (await verified(bundled, asset)) {
          const partial = object + '.copy'; await removeFile(partial); await copyFile(bundled, partial); await rename(partial, object);
        } else {
          state.downloading = true;
          const before = state.bytes;
          await this.download(asset, object, signal, bytes => changed({ ...state, bytes: before + bytes }));
        }
      }
      const parts = asset.path.split('/'), target = join(view, ...parts); await localDirectory(view, parts.slice(0, -1));
      const cached = await regular(object), materialized = await regular(target);
      const sameObject = cached && materialized && cached.ino !== 0 && cached.ino === materialized.ino && cached.dev === materialized.dev;
      if (!sameObject && !(await verified(target, asset))) {
        await removeFile(target);
        try { await link(object, target); } catch { await copyFile(object, target); }
      }
      state.completed++; state.bytes += asset.bytes; changed({ ...state });
    }
    // Small configuration files and native executables follow the installed app;
    // only pinned model data is shared between releases.
    const copySupport = async (source: string, destination: string) => {
      await localDirectory(view, relative(view, destination).split(/[\\/]/).filter(Boolean));
      const entries = await readdir(source, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isSymbolicLink()) throw Error('Unexpected link in application resources.');
        const from = join(source, entry.name), to = join(destination, entry.name);
        if (entry.isDirectory()) await copySupport(from, to);
        else if (!modelExtension.test(entry.name)) {
          await localDirectory(destination);
          if ((await lstat(to).catch(() => null))?.isSymbolicLink()) throw Error('Unexpected link in model storage.');
          const current = await readFile(to).catch(() => null), incoming = await readFile(from);
          if (!current || !incoming.equals(current)) await copyFile(from, to);
        }
      }
    };
    for (const group of groups) await copySupport(join(this.resources, group), join(view, group));
    return view;
  }
}

export async function readModelAssetCatalog(resources: string): Promise<ModelCatalog | null> {
  const path = join(resources, 'model-assets.json');
  try { return modelAssetsSchema.parse(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw Error('The included model catalog could not be verified. Reinstall TinyGPT.'); }
}
