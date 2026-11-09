import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { totalmem } from 'node:os';
import type { BuiltInHardware } from '../shared/managed-local';

const exec = promisify(execFile);
const GiB = 2 ** 30;
export function assessBuiltInHardware(platform: string, arch: string, ram: number, csv?: string): BuiltInHardware {
  const base = { checkedAt: new Date().toISOString(), includedSupported: platform === 'win32' && arch === 'x64' || platform === 'darwin' && arch === 'arm64', proCompatible: false };
  if (!base.includedSupported) return { ...base, status: 'incompatible', message: 'Built-in setup is not available on this device yet.' };
  if (platform !== 'win32') return { ...base, status: 'incompatible', message: 'Device check complete.' };
  if (ram < 15 * GiB) return { ...base, status: 'incompatible', message: 'Device check complete.' };
  if (csv === undefined) return { ...base, status: 'unknown', message: 'Device check complete. Compatibility could not be confirmed.' };
  // One qualified CUDA device, never the sum of several adapters. Other backends
  // remain unavailable for Pro until their long-context runtime is qualified.
  const devices = csv.trim().split(/\r?\n/).flatMap(line => {
    const [name, total, free, compute, driver, uuid, index] = line.split(',').map(x => x.trim().replace(/^"|"$/g, ''));
    const numbers = [total, free, compute, driver, index].map(Number);
    if (numbers.some(n => !Number.isFinite(n)) || !/^GPU-[\w-]+$/.test(uuid || '') || !Number.isInteger(numbers[4]) || numbers[4] < 0) return [];
    if (numbers[0] < 15 * 1024 || numbers[1] < 0 || numbers[1] > numbers[0] || numbers[2] < 7.5 || numbers[3] < 551.61) return [];
    return [{ name, uuid, index: numbers[4], totalBytes: numbers[0] * 2 ** 20, freeBytes: numbers[1] * 2 ** 20 }];
  }).sort((a, b) => b.freeBytes - a.freeBytes);
  if (!devices.length) return { ...base, status: 'incompatible', message: 'Device check complete.' };
  return { ...base, status: 'compatible', proCompatible: true, message: 'Pro is compatible with this device.', device: devices[0] };
}
export async function scanBuiltInHardware(): Promise<BuiltInHardware> {
  let csv: string | undefined;
  if (process.platform === 'win32' && process.arch === 'x64') {
    try { csv = (await exec('nvidia-smi', ['--query-gpu=name,memory.total,memory.free,compute_cap,driver_version,uuid,index', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 7000, maxBuffer: 65536 })).stdout; } catch { /* Missing or unreadable device data is not a compatibility pass. */ }
  }
  return assessBuiltInHardware(process.platform, process.arch, totalmem(), csv);
}
