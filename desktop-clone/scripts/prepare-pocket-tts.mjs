import { readFile, writeFile, mkdir, stat, rename, copyFile, chmod } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
const root = resolve(import.meta.dirname, '..'), destination = join(root, 'runtimes/voice/pocket-tts');
const lock = JSON.parse(await readFile(join(root, 'scripts/pocket-assets.lock.json'), 'utf8'));
const platform = `${process.platform}-${process.arch}`, binary = lock.binaries[platform];
if (!binary) throw Error(`Pocket TTS is not bundled for ${platform}.`);
async function hash(path) { const digest = createHash('sha256'); for await (const bytes of createReadStream(path)) digest.update(bytes); return digest.digest('hex'); }
async function download(asset, path) {
  await mkdir(dirname(path), { recursive: true });
  if ((await stat(path).catch(() => null))?.size === asset.size && await hash(path) === asset.sha256) return;
  console.log(`Preparing Pocket TTS: ${asset.name}`);
  const response = await fetch(asset.url, { signal: AbortSignal.timeout(600000) });
  if (!response.ok || !response.body) throw Error(`Pocket TTS download failed (HTTP ${response.status}).`);
  const partial = path + '.partial'; await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  if ((await stat(partial)).size !== asset.size || await hash(partial) !== asset.sha256) throw Error(`Pocket TTS checksum mismatch: ${asset.name}`);
  await rename(partial, path);
}
const archive = join(root, 'runtimes/.voice-cache', binary.name);
await download(binary, archive);
await mkdir(destination, { recursive: true });
const executable = join(destination, process.platform === 'win32' ? 'pocket-tts.exe' : 'pocket-tts');
const prepared = JSON.parse(await readFile(join(destination, 'prepared.json'), 'utf8').catch(() => '{}'));
if (!(await stat(executable).catch(() => null)) || prepared.archiveSha256 !== binary.sha256 || prepared.target !== platform || await hash(executable) !== prepared.executableSha256) {
  const unpack = join(root, 'runtimes/.voice-cache/pocket-unpack-' + platform); await mkdir(unpack, { recursive: true });
  execFileSync('tar', ['-xf', archive, '-C', unpack], { windowsHide: true });
  const folder = binary.name.replace(/\.(zip|tar\.gz)$/, '');
  await copyFile(join(unpack, folder, process.platform === 'win32' ? 'pocket-tts.exe' : 'pocket-tts'), executable);
  if (process.platform !== 'win32') await chmod(executable, 0o755);
  await writeFile(join(destination, 'prepared.json'), JSON.stringify({ release: lock.release, target: platform, archiveSha256: binary.sha256, executableSha256: await hash(executable) }, null, 2));
}
for (const asset of lock.files) await download(asset, join(destination, asset.name));
await copyFile(join(root, 'scripts/pocket-tts.config.yaml'), join(destination, 'config.template.yaml'));
await copyFile(join(root, 'scripts/pocket-assets.lock.json'), join(destination, 'assets.lock.json'));
console.log('Pocket TTS runtime and streaming voices ready.');
