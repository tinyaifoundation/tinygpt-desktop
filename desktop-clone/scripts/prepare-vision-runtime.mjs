import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, rename, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(join(root, 'src/shared/vision-model.json'), 'utf8'));
const destination = join(root, 'runtimes/vision');
await mkdir(destination, { recursive: true });
async function valid(path, file) {
  if ((await stat(path).catch(() => null))?.size !== file.size) return false;
  const hash = createHash('sha256'); for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex') === file.sha256;
}
await Promise.all(manifest.files.map(async file => {
  const path = join(destination, file.name);
  if (await valid(path, file)) return;
  const partial = path + '.partial';
  try {
    console.log('Preparing bundled vision asset:', file.name);
    const response = await fetch(`https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}/${file.name}`, { signal: AbortSignal.timeout(600000) });
    if (!response.ok || !response.body) throw Error(`Vision asset download failed (${response.status}).`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
    if (!await valid(partial, file)) throw Error('Vision asset checksum or size mismatch: ' + file.name);
    await rename(partial, path);
  } finally { await rm(partial, { force: true }); }
}));
await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Bundled local vision ready: ${manifest.files.reduce((bytes, file) => bytes + file.size, 0)} model bytes; shared llama.cpp runtime.`);
