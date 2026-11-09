import { expect, it, vi } from 'vitest';
import worker from '../release-hosting/worker';
function fixture() {
  const content = new TextEncoder().encode('MZ-fixture-release');
  const get = vi.fn(async (_key: string, options?: { range: Headers }) => {
    const requested = options?.range.get('Range');
    const match = requested && /^bytes=(\d+)-(\d+)$/.exec(requested);
    const range = match ? { offset: Number(match[1]), length: Number(match[2]) - Number(match[1]) + 1 } : undefined;
    return { size: content.length, httpEtag: '"fixture-etag"', body: new Blob([range ? content.slice(range.offset, range.offset + range.length) : content]).stream(), range, writeHttpMetadata(headers: Headers) { headers.set('Content-Type', 'ignored'); } };
  });
  const env = { RELEASES: { get, head: vi.fn(async () => ({ size: content.length })) }, DOWNLOAD_PATH: '/legacy', OBJECT_KEY: 'old.exe', EXTRA_RELEASES: JSON.stringify({ '/private/release.exe': { key: 'new.exe', filename: 'TinyGPT-Setup.exe', sha256: 'a'.repeat(64) } }) };
  return { env, get, content };
}
it('preserves legacy downloads and only exposes explicitly allowed objects', async () => {
  const { env, get } = fixture();
  expect((await worker.fetch(new Request('https://download.test/legacy'), env)).status).toBe(200);
  expect(get).toHaveBeenCalledWith('old.exe', expect.anything());
  for (const path of ['/', '/new.exe', '/private', '/private/other.exe', '/__proto__']) expect((await worker.fetch(new Request('https://download.test' + path), env)).status).toBe(404);
  expect((await worker.fetch(new Request('https://download.test/private/release.exe', { method: 'PUT', body: 'overwrite' }), env)).status).toBe(404);
});
it('returns attachment metadata and an empty HEAD response', async () => {
  const { env, content } = fixture();
  const response = await worker.fetch(new Request('https://download.test/private/release.exe', { method: 'HEAD' }), env);
  expect(response.status).toBe(200); expect(await response.text()).toBe('');
  expect(response.headers.get('Content-Length')).toBe(String(content.length));
  expect(response.headers.get('Content-Disposition')).toContain('TinyGPT-Setup.exe');
  expect(response.headers.get('X-Checksum-SHA256')).toBe('a'.repeat(64));
  expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
});
it('supports byte ranges and rejects malformed or multiple ranges', async () => {
  const { env, content } = fixture();
  const response = await worker.fetch(new Request('https://download.test/private/release.exe', { headers: { Range: 'bytes=0-1' } }), env);
  expect(response.status).toBe(206); expect(await response.text()).toBe('MZ');
  expect(response.headers.get('Content-Range')).toBe(`bytes 0-1/${content.length}`);
  expect(response.headers.get('Content-Length')).toBe('2');
  const invalid = await worker.fetch(new Request('https://download.test/private/release.exe', { headers: { Range: 'bytes=0-1,4-5' } }), env);
  expect(invalid.status).toBe(416); expect(invalid.headers.get('Content-Range')).toBe(`bytes */${content.length}`);
});
it('serves only content-addressed models, scoped release artifacts and the fixed pre-beta feed', async () => {
  const { env, get } = fixture();
  const model = 'a'.repeat(64);
  expect((await worker.fetch(new Request('https://download.test/assets/sha256/' + model), env)).status).toBe(200);
  expect(get).toHaveBeenLastCalledWith('assets/sha256/' + model, expect.anything());
  const feed = await worker.fetch(new Request('https://download.test/updates/prebeta/win-x64/prebeta.yml'), env);
  expect(feed.headers.get('Content-Type')).toBe('application/yaml; charset=utf-8'); expect(feed.headers.get('Cache-Control')).toContain('max-age=0');
  expect(get).toHaveBeenLastCalledWith('updates/prebeta/win-x64/prebeta.yml', expect.anything());
  const authenticated = await worker.fetch(new Request('https://download.test/updates/prebeta/win-x64/prebeta.json'), env);
  expect(authenticated.status).toBe(200); expect(authenticated.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
  expect(get).toHaveBeenLastCalledWith('updates/prebeta/win-x64/prebeta.json', expect.anything());
  expect((await worker.fetch(new Request('https://download.test/releases/0.1.0-prebeta.3/TinyGPT-Setup.exe'), env)).status).toBe(200);
  expect(get).toHaveBeenLastCalledWith('releases/0.1.0-prebeta.3/TinyGPT-Setup.exe', expect.anything());
  for (const path of ['/assets/sha256/not-a-hash','/assets/sha256/','/updates/stable/latest.yml','/releases/0.1.0-prebeta.3/credentials.json','/releases/0.1.0-prebeta.3/..secret.exe']) expect((await worker.fetch(new Request('https://download.test' + path), env)).status).toBe(404);
});
