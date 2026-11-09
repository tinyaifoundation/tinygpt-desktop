import { createPublicKey, createPrivateKey, sign, verify } from 'node:crypto';
import { parse } from 'yaml';
import type { UpdateInfo } from 'builder-util-runtime';

const domain = 'TinyGPT Windows pre-beta update v1\n';
const fail = () => { throw Error('The TinyGPT release proof is invalid.'); };
const base64 = (value: unknown, bytes: number): value is string => typeof value === 'string' && Buffer.from(value, 'base64').length === bytes && Buffer.from(value, 'base64').toString('base64') === value;
export function updatePublicKey(value: string) {
  const key = createPublicKey({ key: Buffer.from(value, 'base64'), type: 'spki', format: 'der' });
  if (key.asymmetricKeyType !== 'ed25519') fail();
  return key;
}
export function verifyReleaseEnvelope(text: string, publicKey: string): UpdateInfo {
  if (Buffer.byteLength(text) > 150_000) fail();
  const envelope = JSON.parse(text);
  if (envelope.schema !== 1 || typeof envelope.payload !== 'string' || Buffer.byteLength(envelope.payload) > 100_000 || !base64(envelope.signature, 64)) fail();
  if (!verify(null, Buffer.from(domain + envelope.payload), updatePublicKey(publicKey), Buffer.from(envelope.signature, 'base64'))) fail();
  const info = parse(envelope.payload, { maxAliasCount: 10 });
  if (!info || !/^\d+\.\d+\.\d+-prebeta\.\d+$/.test(info.version)) fail();
  const root = `https://downloads.tinygpt.org/releases/${info.version}/`;
  const artifact = (value: unknown, extension: string) => typeof value === 'string' && value.startsWith(root) && new RegExp(`^[\\w.-]+\\.${extension}$`).test(value.slice(root.length)) && !value.slice(root.length).includes('..');
  if (!Array.isArray(info.files) || info.files.length !== 1 || !artifact(info.path, 'exe') || info.files[0].url !== info.path || !base64(info.sha512, 64) || info.sha512 !== info.files[0].sha512) fail();
  if (info.files[0].size !== undefined && (!Number.isSafeInteger(info.files[0].size) || info.files[0].size <= 0)) fail();
  if (!info.packages || Object.keys(info.packages).join(',') !== 'x64') fail();
  const pkg = info.packages.x64;
  if (!pkg || !artifact(pkg.path, '7z') || !base64(pkg.sha512, 64) || !Number.isSafeInteger(pkg.size) || pkg.size <= 0 || !Number.isSafeInteger(pkg.blockMapSize) || pkg.blockMapSize <= 0 || pkg.blockMapSize >= pkg.size) fail();
  return info as UpdateInfo;
}
export function createReleaseEnvelope(payload: string, privateKey: string, publicKey: string): string {
  const key = createPrivateKey({ key: Buffer.from(privateKey, 'base64'), type: 'pkcs8', format: 'der' });
  if (key.asymmetricKeyType !== 'ed25519') fail();
  const result = JSON.stringify({ schema: 1, payload, signature: sign(null, Buffer.from(domain + payload), key).toString('base64') }) + '\n';
  verifyReleaseEnvelope(result, publicKey); // Refuse a private key that doesn't match installed clients.
  return result;
}
