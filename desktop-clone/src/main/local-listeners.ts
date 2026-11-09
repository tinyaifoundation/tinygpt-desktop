import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { localEndpoint } from '../core/inference-discovery';
const execute = promisify(execFile);

export async function localCandidates(configured: string): Promise<string[]> {
  const endpoints = new Set<string>();
  try { endpoints.add(localEndpoint(configured)); } catch { /* Remote manual configurations do not participate in a local scan. */ }
  for (const port of [11434, 1234, 8080, 8000, 5000]) endpoints.add(`http://127.0.0.1:${port}/v1`);
  try {
    const { stdout } = await execute(process.platform === 'win32' ? 'C:\\Windows\\System32\\netstat.exe' : '/usr/sbin/netstat', ['-an'], { timeout: 2000, maxBuffer: 1_000_000, windowsHide: true });
    for (const line of stdout.split('\n')) {
      if (!/LISTEN/i.test(line)) continue;
      const address = line.match(/(?:127\.0\.0\.1|0\.0\.0\.0)[:.](\d+)\s/) ?? line.match(/\*\.(\d+)\s/);
      if (address && Number(address[1]) > 1024) endpoints.add(`http://127.0.0.1:${address[1]}/v1`);
      const ipv6 = line.match(/\[(?:::1|::)\]:(\d+)\s/) ?? line.match(/::1\.(\d+)\s/);
      if (ipv6 && Number(ipv6[1]) > 1024) endpoints.add(`http://[::1]:${ipv6[1]}/v1`);
      if (endpoints.size >= 40) break;
    }
  } catch { /* Conventional ports still work when listener enumeration is unavailable. */ }
  const unique = new Map<string, string>();
  for (const endpoint of endpoints) { const url = new URL(endpoint); const host = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname; const identity = `${url.protocol}//${host}:${url.port}${url.pathname}`; if (!unique.has(identity)) unique.set(identity, endpoint); }
  return [...unique.values()];
}
