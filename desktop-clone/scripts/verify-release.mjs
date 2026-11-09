import { readFile, writeFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { parse } from 'yaml';
const root = resolve(import.meta.dirname, '..');
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const directory = join(root, 'release/nsis-web'), metadata = parse(await readFile(join(directory, 'prebeta.yml'), 'utf8'));
const publisher = process.env.TINYGPT_PUBLISHER_NAME?.trim();
if (process.platform !== 'win32' || !publisher) throw Error('Verify signed releases on Windows with TINYGPT_PUBLISHER_NAME set.');
if (metadata.version !== version || !metadata.packages?.x64?.blockMapSize) throw Error('Versioned differential update metadata is missing.');
const files = [];
for (const [name, expected] of [[metadata.path, { sha512: metadata.sha512 }], [metadata.packages.x64.path, metadata.packages.x64]]) {
  if (typeof name !== 'string' || !/^[\w.-]+$/.test(name)) throw Error('Unexpected release artifact path.');
  const path = join(directory, name), hash = createHash('sha256'), integrity = createHash('sha512'); let bytes = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk); integrity.update(chunk); bytes += chunk.length; }
  if (integrity.digest('base64') !== expected.sha512 || (expected.size && bytes !== expected.size)) throw Error('Release checksum differs from builder metadata.');
  files.push({ name, bytes, sha256: hash.digest('hex') });
}
for (const path of [join(directory, metadata.path), join(root, 'release/win-unpacked/TinyGPT.exe')]) execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(root, 'scripts/verify-code-signature.ps1'), '-Path', path, '-Publisher', publisher], { stdio: 'inherit', windowsHide: true });
const packaged = parse(await readFile(join(root, 'release/win-unpacked/resources/app-update.yml'), 'utf8'));
if (![packaged.publisherName].flat().includes(publisher)) throw Error('Packaged updater does not pin the signing publisher.');
await stat(join(root, 'release/win-unpacked/resources/model-assets.json'));
await writeFile(join(directory, 'SHA256SUMS.txt'), files.map(file => `${file.sha256}  ${file.name}`).join('\n') + '\n');
const notesPath = join(root, 'release-notes', `${version}.md`);
const notes = await readFile(notesPath, 'utf8');
if (notes.trim().length < 40) throw Error('Write release notes before shipping.');
await writeFile(join(directory, 'START-HERE.txt'), notes);
await writeFile(join(directory, 'verified-release.json'), JSON.stringify({ version, publisher, verifiedAt: new Date().toISOString(), files }, null, 2));
console.log('Signed Windows release verified. No files have been published yet.');
