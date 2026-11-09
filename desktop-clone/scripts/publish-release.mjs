import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { S3Client, HeadObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { parse, stringify } from 'yaml';
import { updateFeed } from './release-metadata.mjs';
const root = resolve(import.meta.dirname, '..');
function required(name) { const value = process.env[name]; if (!value) throw Error(`Set ${name} before publishing.`); return value; }
// Recheck the actual files and signatures immediately before publication.
execFileSync(process.execPath, [join(root, 'scripts/verify-release.mjs')], { stdio: 'inherit', windowsHide: true });
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const directory = join(root, 'release/nsis-web');
const metadata = parse(await readFile(join(directory, 'prebeta.yml'), 'utf8'));
const verification = JSON.parse(await readFile(join(directory, 'verified-release.json'), 'utf8'));
if (verification.version !== version) throw Error('Stale verified release.');
const assets = JSON.parse(await readFile(join(root, '.tmp/model-asset-uploads.json'), 'utf8'));
const account = required('CLOUDFLARE_ACCOUNT_ID'); if (!/^[a-f0-9]{32}$/.test(account)) throw Error('Invalid Cloudflare account identifier.');
const Bucket = required('R2_RELEASE_BUCKET');
const client = new S3Client({ endpoint: `https://${account}.r2.cloudflarestorage.com`, region: 'auto', credentials: { accessKeyId: required('R2_ACCESS_KEY_ID'), secretAccessKey: required('R2_SECRET_ACCESS_KEY') }, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
async function checksum(path) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }
async function immutable(path, Key, expected) {
  const sha256 = await checksum(path); if (expected && expected !== sha256) throw Error('A release artifact changed after verification.');
  let existing; try { existing = await client.send(new HeadObjectCommand({ Bucket, Key })); } catch (error) { if (error.$metadata?.httpStatusCode !== 404) throw error; }
  if (existing) { if (existing.Metadata?.sha256 !== sha256) throw Error('Refusing to replace an existing release object.'); console.log('Already uploaded: ' + Key); return; }
  const upload = new Upload({ client, params: { Bucket, Key, Body: createReadStream(path), Metadata: { sha256 }, ContentType: /\.(txt|md)$/.test(Key) ? 'text/plain; charset=utf-8' : 'application/octet-stream', CacheControl: 'public, max-age=31536000, immutable' }, queueSize: 2, partSize: 32 * 1024 * 1024, leavePartsOnError: false });
  await upload.done();
  const result = await client.send(new HeadObjectCommand({ Bucket, Key })); if (result.Metadata?.sha256 !== sha256) throw Error('Upload metadata verification failed.');
  // Stream the stored object back: this checks the bytes, not just caller-supplied metadata.
  const downloaded = await client.send(new GetObjectCommand({ Bucket, Key })); const hash = createHash('sha256'); for await (const chunk of downloaded.Body) hash.update(chunk);
  if (hash.digest('hex') !== sha256) throw Error('Uploaded bytes differ from the verified release.');
  console.log('Uploaded and verified: ' + Key);
}
for (const asset of new Map(assets.map(asset => [asset.key, asset])).values()) await immutable(asset.source, asset.key, asset.sha256);
for (const file of verification.files) await immutable(join(directory, file.name), `releases/${version}/${file.name}`, file.sha256);
for (const name of ['START-HERE.txt', 'SHA256SUMS.txt', 'prebeta.yml']) await immutable(join(directory, name), `releases/${version}/${name}`);
const notes = await readFile(join(directory, 'START-HERE.txt'), 'utf8');
const feed = stringify(updateFeed(metadata, notes));
// Single-object promotion happens last. Existing clients cannot discover a partial upload.
await client.send(new PutObjectCommand({ Bucket, Key: 'updates/prebeta/win-x64/prebeta.yml', Body: feed, ContentType: 'application/yaml; charset=utf-8', CacheControl: 'no-store' }));
console.log(`Published TinyGPT ${version} to the Windows pre-beta update channel.`);
