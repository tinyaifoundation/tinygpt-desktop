import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpus, freemem, totalmem } from 'node:os';
import type { ComponentMemory, ConfigurationMonitorSnapshot, GraphicsReading, MonitorComponent } from '../shared/configuration-monitor';

const exec = promisify(execFile);
const number = (value: unknown, max = Number.MAX_SAFE_INTEGER): number | null => {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 && parsed <= max ? parsed : null;
};
const rows = <T>(value: T | T[] | undefined): T[] => value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
export function nvidiaReadings(csv: string): GraphicsReading[] {
  return csv.trim().split(/\r?\n/).flatMap(line => {
    const [index, id, name, total, used, activity, temperature] = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(value => value.trim().replace(/^"|"$/g, ''));
    if (!/^\d+$/.test(index ?? '') || !/^GPU-[\w-]+$/.test(id ?? '') || !name) return [];
    const totalMiB = number(total), usedMiB = number(used);
    return [{ id, name, totalBytes: totalMiB && totalMiB * 2 ** 20 || null, usedBytes: usedMiB !== null && (totalMiB === null || usedMiB <= totalMiB) ? usedMiB * 2 ** 20 : null, activity: number(activity, 100), temperature: number(temperature, 125) }];
  });
}

type WindowsData = {
  processes?: { pid: number; memory: number }[];
  graphics?: { pid: number; dedicated: number; shared: number }[];
  adapters?: { id: string; used: number }[];
};
export function windowsComponents(components: MonitorComponent[], data: WindowsData | null): ComponentMemory[] {
  return components.map(component => {
    const processes = rows(data?.processes).filter(item => component.pids.includes(item.pid));
    const graphics = rows(data?.graphics).filter(item => component.pids.includes(item.pid));
    const residentMemory = processes.map(item => number(item.memory));
    const allocations = graphics.map(item => number(item.dedicated));
    return { id: component.id, name: component.name, state: component.state,
      memoryBytes: component.memoryBytes ?? (component.pids.length === 0 ? 0 : processes.length === component.pids.length && residentMemory.every(item => item !== null) ? residentMemory.reduce<number>((sum, item) => sum + item!, 0) : null),
      // Windows allocations can be shared by processes. They are deliberately
      // not subtracted from the GPU total to invent an "other apps" slice.
      graphicsBytes: component.pids.length === 0 ? 0 : data?.graphics && allocations.every(item => item !== null) ? allocations.reduce<number>((sum, item) => sum + item!, 0) : null };
  });
}

export function macMemory(vm: string, total: number): { totalBytes: number; usedBytes: number; pressure: null } | undefined {
  const pageSize = Number(vm.match(/page size of (\d+) bytes/)?.[1]);
  const pages = (key: string) => Number(vm.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1]);
  const values = ['Anonymous pages', 'Pages wired down', 'Pages occupied by compressor', 'Pages purgeable'].map(pages);
  if (!Number.isFinite(pageSize) || pageSize <= 0 || values.some(value => !Number.isFinite(value))) return;
  const used = (values[0] + values[1] + values[2] - values[3]) * pageSize;
  return used >= 0 && used <= total ? { totalBytes: total, usedBytes: used, pressure: null } : undefined;
}
export function macGraphics(ioreg: string, name: string): GraphicsReading[] {
  const value = (key: string, max: number) => number(ioreg.match(new RegExp(`"${key}"\\s*=\\s*(\\d+(?:\\.\\d+)?)`))?.[1], max);
  return [{ id: 'unified', name, totalBytes: null, usedBytes: null, activity: value('Device Utilization %', 100), temperature: value('Temperature\\(C\\)', 125) }];
}

/** Read-only telemetry, requested only while Configuration is visible. */
export class ConfigurationMonitor {
  private pending?: Promise<ConfigurationMonitorSnapshot>;
  private cached?: ConfigurationMonitorSnapshot;
  constructor(private components: () => MonitorComponent[]) {}
  sample(): Promise<ConfigurationMonitorSnapshot> {
    if (this.pending) return this.pending;
    if (this.cached && Date.now() - this.cached.sampledAt < 2000) return Promise.resolve(this.cached);
    this.pending = this.read().then(snapshot => this.cached = snapshot).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async command(file: string, args: string[]): Promise<string | undefined> {
    try { return (await exec(file, args, { windowsHide: true, timeout: 4500, maxBuffer: 512 * 1024, env: { ...process.env, LC_ALL: 'C' } })).stdout; } catch { return; }
  }
  private async read(): Promise<ConfigurationMonitorSnapshot> {
    const components = this.components();
    const total = totalmem();
    let systemMemory: ConfigurationMonitorSnapshot['systemMemory'] = { totalBytes: total, usedBytes: Math.max(0, total - freemem()), pressure: null };
    let graphics: GraphicsReading[] = [];
    let memories: ComponentMemory[] = components.map(component => ({ id: component.id, name: component.name, state: component.state, memoryBytes: component.memoryBytes ?? (component.pids.length ? null : 0), graphicsBytes: null }));
    if (process.platform === 'win32') {
      const pids = [...new Set(components.flatMap(component => component.pids))].filter(pid => Number.isSafeInteger(pid) && pid > 0);
      const script = `$ErrorActionPreference='Stop'; $ids=@(${pids.join(',')}); $result=@{}; try {$result.processes=@(Get-Process -Id $ids -ErrorAction SilentlyContinue | ForEach-Object {@{pid=$_.Id;memory=$_.WorkingSet64}})} catch {}; try {$result.graphics=@(Get-CimInstance Win32_PerfRawData_GPUPerformanceCounters_GPUProcessMemory | Where-Object {$_.Name -match '^pid_(\\d+)_' -and $ids -contains [int]$Matches[1]} | ForEach-Object {$null=$_.Name -match '^pid_(\\d+)_';@{pid=[int]$Matches[1];dedicated=$_.DedicatedUsage;shared=$_.SharedUsage}})} catch {}; try {$result.adapters=@(Get-CimInstance Win32_PerfRawData_GPUPerformanceCounters_GPUAdapterMemory | ForEach-Object {@{id=$_.Name;used=$_.DedicatedUsage}})} catch {}; ConvertTo-Json -InputObject $result -Depth 4 -Compress`;
      const [csv, json] = await Promise.all([
        this.command('nvidia-smi', ['--query-gpu=index,uuid,name,memory.total,memory.used,utilization.gpu,temperature.gpu', '--format=csv,noheader,nounits']),
        this.command('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]),
      ]);
      let data: WindowsData | null = null;
      try { if (json) data = JSON.parse(json); } catch { /* A failed sample remains unavailable. */ }
      memories = windowsComponents(components, data);
      graphics = csv ? nvidiaReadings(csv) : [];
      if (!graphics.length) graphics = rows(data?.adapters).filter(adapter => number(adapter.used) !== null && adapter.used > 0).map((adapter, index) => ({ id: adapter.id, name: `Graphics adapter ${index + 1}`, totalBytes: null, usedBytes: Number(adapter.used), activity: null, temperature: null }));
    } else if (process.platform === 'darwin') {
      const pids = [...new Set(components.flatMap(component => component.pids))].filter(pid => Number.isSafeInteger(pid) && pid > 0);
      const [vm, pressure, ioreg, ps] = await Promise.all([
        this.command('/usr/bin/vm_stat', []), this.command('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']),
        this.command('/usr/sbin/ioreg', ['-r', '-c', 'AGXAccelerator', '-l']),
        pids.length ? this.command('/bin/ps', ['-o', 'pid=,rss=', '-p', pids.join(',')]) : Promise.resolve(undefined),
      ]);
      systemMemory = vm && macMemory(vm, total) || systemMemory;
      const level = Number(pressure?.trim()); systemMemory.pressure = level === 1 ? 'normal' : level === 2 ? 'elevated' : level === 4 ? 'high' : null;
      graphics = macGraphics(ioreg ?? '', cpus()[0]?.model || 'Apple graphics');
      const processes = ps?.trim().split(/\r?\n/).flatMap(line => { const [pid, rss] = line.trim().split(/\s+/).map(Number); return Number.isSafeInteger(pid) && Number.isFinite(rss) ? [{ pid, rss: rss * 1024 }] : []; }) ?? [];
      memories = components.map(component => {
        const matching = processes.filter(process => component.pids.includes(process.pid));
        return { id: component.id, name: component.name, state: component.state, memoryBytes: component.memoryBytes ?? (!component.pids.length ? 0 : matching.length === component.pids.length ? matching.reduce((sum, process) => sum + process.rss, 0) : null), graphicsBytes: null };
      });
    }
    return { sampledAt: Date.now(), platform: process.platform, unified: process.platform === 'darwin' && process.arch === 'arm64', systemMemory, graphics, components: memories };
  }
}
