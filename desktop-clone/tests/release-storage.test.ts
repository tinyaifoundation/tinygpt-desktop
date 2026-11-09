import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { expect, it, vi } from 'vitest';
// @ts-expect-error Release helpers are plain Node ESM used by the Windows build workflow.
import { verifyStoredObject } from '../scripts/release-storage.mjs';
it('verifies streamed remote bytes for new uploads and reused immutable objects', async () => {
  const bytes = Buffer.from('release artifact bytes'), sha = createHash('sha256').update(bytes).digest('hex');
  const client = { send: vi.fn(async (_command: { input: { Bucket: string; Key: string } }) => ({ Body: Readable.from([bytes.subarray(0, 4), bytes.subarray(4)]) })) };
  await verifyStoredObject(client, 'fixture-bucket', 'releases/0.1.0-prebeta.3/setup.exe', sha);
  expect(client.send.mock.calls[0][0].input).toEqual({ Bucket: 'fixture-bucket', Key: 'releases/0.1.0-prebeta.3/setup.exe' });
});
it('rejects corrupt or missing stored bytes even if metadata claims the expected checksum', async () => {
  const sha = createHash('sha256').update('expected bytes').digest('hex');
  await expect(verifyStoredObject({ send: async () => ({ Body: Readable.from(['corrupt']), Metadata: { sha256: sha } }) }, 'bucket', 'key', sha)).rejects.toThrow(/bytes differ/);
  await expect(verifyStoredObject({ send: async () => ({}) }, 'bucket', 'key', sha)).rejects.toThrow(/no content/);
});
