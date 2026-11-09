// Runs from the new installer before the previous app is removed. No network or deletion.
const { readFile, mkdir, lstat, copyFile, link, rename, unlink } = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { createHash } = require('node:crypto');
const { resolve, join } = require('node:path');
async function migrate(resources, storage, catalogFile) {
  const catalog = JSON.parse(await readFile(catalogFile, 'utf8'));
  if (catalog.version !== 1 || !Array.isArray(catalog.files)) throw Error('Invalid model catalog');
  const root = resolve(resources), objects = join(resolve(storage), 'objects');
  await mkdir(objects, { recursive: true });
  if ((await lstat(objects)).isSymbolicLink()) throw Error('Invalid model storage');
  for (const asset of catalog.files) {
    if (!/^[a-f0-9]{64}$/.test(asset.sha256) || !/^(voice-runtime|rag|vision)\/[\w./-]+$/.test(asset.path) || asset.path.split('/').some(part => !part || part === '.' || part === '..')) throw Error('Invalid model catalog path');
    const source = join(root, ...asset.path.split('/')), target = join(objects, asset.sha256);
    const existing = await lstat(target).catch(() => null); if (existing?.isFile() && !existing.isSymbolicLink()) continue;
    if (existing) throw Error('Invalid model cache entry');
    const file = await lstat(source).catch(() => null); if (!file?.isFile() || file.isSymbolicLink() || file.size !== asset.bytes) continue;
    const hash = createHash('sha256'); for await (const chunk of createReadStream(source)) hash.update(chunk);
    if (hash.digest('hex') !== asset.sha256) continue;
    try { await link(source, target); }
    catch { const partial = target + '.migration'; await unlink(partial).catch(() => {}); await copyFile(source, partial); await rename(partial, target); }
  }
}
module.exports = { migrate };
if (require.main === module) migrate(...process.argv.slice(2)).catch(() => { process.exitCode = 1; });
