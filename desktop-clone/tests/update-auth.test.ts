import { generateKeyPairSync } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { createReleaseEnvelope, verifyReleaseEnvelope } from '../src/main/update-auth';
import { AuthenticatedUpdateProvider } from '../src/main/update-provider';
import pinned from '../src/shared/update-key.json';
const keys = () => { const key = generateKeyPairSync('ed25519'); return { publicKey: key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), privateKey: key.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') }; };
const sha512 = Buffer.alloc(64, 1).toString('base64');
function metadata() {
  const root = 'https://downloads.tinygpt.org/releases/0.1.0-prebeta.3/';
  return { version: '0.1.0-prebeta.3', path: root + 'setup.exe', sha512, files: [{ url: root + 'setup.exe', sha512, size: 123 }], packages: { x64: { path: root + 'app.nsis.7z', sha512, size: 1000, blockMapSize: 20 } } };
}
it('authenticates the full immutable artifact metadata with the pinned release key', () => {
  const key = keys(), info = metadata();
  const envelope = createReleaseEnvelope(stringify(info), key.privateKey, key.publicKey);
  expect(verifyReleaseEnvelope(envelope, key.publicKey)).toEqual(info);
  const changed = JSON.parse(envelope); changed.payload = changed.payload.replace('setup.exe', 'replacement.exe');
  expect(() => verifyReleaseEnvelope(JSON.stringify(changed), key.publicKey)).toThrow();
  expect(() => verifyReleaseEnvelope(envelope, keys().publicKey)).toThrow();
  expect(() => createReleaseEnvelope(stringify(info), key.privateKey, keys().publicKey)).toThrow();
});
it('refuses malformed proofs, unsafe URLs and unusable package checksums before download', () => {
  const key = keys();
  for (const value of ['{}', 'null', 'x'.repeat(150001), JSON.stringify({ schema: 1, payload: '', signature: 'invalid' })]) expect(() => verifyReleaseEnvelope(value, key.publicKey)).toThrow();
  const base = metadata();
  for (const info of [{ ...base, path: 'https://other.example/setup.exe' }, { ...base, sha512: 'wrong' }, { ...base, files: [] }, { ...base, packages: { x64: { ...base.packages.x64, path: 'https://downloads.tinygpt.org/releases/0.1.0-prebeta.4/app.7z' } } }, { ...base, packages: { x64: { ...base.packages.x64, blockMapSize: 0 } } }]) {
    expect(() => createReleaseEnvelope(stringify(info), key.privateKey, key.publicKey)).toThrow();
  }
});
it('the actual updater provider never falls back to an unauthenticated YAML feed', async () => {
  const executor = { request: vi.fn(async (_options: unknown) => stringify(metadata())) };
  const provider = new AuthenticatedUpdateProvider({}, {} as never, { executor: executor as never, platform: 'win32', isUseMultipleRangeRequest: true });
  await expect(provider.getLatestVersion()).rejects.toThrow();
  expect(executor.request).toHaveBeenCalledTimes(1);
  expect(executor.request.mock.calls[0]?.[0]).toMatchObject({ path: '/updates/prebeta/win-x64/prebeta.json' });
  expect(provider.isUseMultipleRangeRequest).toBe(false);
});
it('the actual provider resolves authenticated metadata and forces single ranges for the download Worker', async () => {
  const key = keys(), previous = pinned.publicKey, info = metadata();
  const executor = { request: vi.fn(async (_options: unknown) => createReleaseEnvelope(stringify(info), key.privateKey, key.publicKey)) };
  pinned.publicKey = key.publicKey;
  try {
    const provider = new AuthenticatedUpdateProvider({}, {} as never, { executor: executor as never, platform: 'win32', isUseMultipleRangeRequest: true });
    const authenticated = await provider.getLatestVersion();
    expect(authenticated).toEqual(info);
    expect(provider.resolveFiles(authenticated)[0].url.href).toBe(info.path);
    expect(provider.isUseMultipleRangeRequest).toBe(false);
  } finally { pinned.publicKey = previous; }
});
