import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
afterEach(() => vi.unstubAllGlobals());
it('does not run cookie-authenticated phone push requests through desktop nonce replay storage', async () => {
  const workerPath = '../remote-relay/src/worker'; const { DesktopRelay } = await import(workerPath);
  vi.stubGlobal('WebSocketRequestResponsePair', class {});
  const desktop = 'a'.repeat(64), secret = 'b'.repeat(64), values = new Map<string, unknown>();
  values.set('devices', [{ id: randomUUID(), sessionHash: createHash('sha256').update(secret).digest('hex'), expiresAt: Date.now() + 60000 }]);
  const storage = { get: async (key: string) => values.get(key), put: async (key: string, value: unknown) => values.set(key, value), transaction: async (operation: (tx: unknown) => unknown) => operation(storage) };
  const relay = new DesktopRelay({ storage, setWebSocketAutoResponse() {} } as any, {} as any);
  const register = vi.fn(async () => ({ eventId: randomUUID() })); (relay as any).pushes = { register };
  for (const op of ['subscribe', 'subscribe', 'test', 'test']) { const response = await relay.fetch(new Request(`https://mobile.tinygpt.org/api/d/${desktop}/push`, { method: 'POST', headers: { Cookie: `tg2_${desktop}=${secret}` }, body: JSON.stringify({ op }) })); expect(response.status).toBe(200); }
  expect(register).toHaveBeenCalledTimes(4); expect(values.has('nonces')).toBe(false);
  expect((await relay.fetch(new Request(`https://mobile.tinygpt.org/api/d/${desktop}/devices`))).status).toBe(401);
  const nonce = randomUUID(), request = () => new Request(`https://mobile.tinygpt.org/api/d/${desktop}/devices`, { headers: { 'X-TinyGPT-Nonce': nonce } });
  expect((await relay.fetch(request())).status).toBe(200); expect((await relay.fetch(request())).status).toBe(401);
});
