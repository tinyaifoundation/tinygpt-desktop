import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { freemem, totalmem } from 'node:os';
import type { GpuSample } from '../shared/diagnostics';

const exec = promisify(execFile);
const fields = ['index', 'uuid', 'utilization.gpu', 'utilization.memory', 'memory.used', 'memory.total', 'clocks.current.sm', 'clocks.current.memory', 'power.draw', 'power.limit', 'temperature.gpu', 'pstate', 'clocks_event_reasons.sw_power_cap', 'clocks_event_reasons.hw_thermal_slowdown', 'clocks_event_reasons.sw_thermal_slowdown'];
const numeric = (value: string | undefined) => value?.trim() && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1e12 ? Number(value) : null;
const active = (value: string | undefined) => /^(active|enabled|yes)$/i.test(value ?? '') ? true : /^(not active|disabled|no)$/i.test(value ?? '') ? false : null;
const rows = (csv: string) => csv.trim().split(/\r?\n/).filter(Boolean).map(line => line.split(',').map(x => x.trim()));

/** UUIDs/PIDs are used transiently to associate numeric readings; neither
 * process names, arguments, UUIDs nor raw command output are persisted. */
export function parseGpuSample(csv: string, processes: string | undefined, ownedPids: number[], memory = { free: freemem(), total: totalmem() }): GpuSample {
  const apps = processes === undefined ? undefined : rows(processes);
  const devices = rows(csv).slice(0, 16).flatMap(parts => {
    const [index, uuid, util, memUtil, used, total, sm, clock, watts, limit, temp, state, power, heat, softwareHeat] = parts;
    const id = numeric(index); if (id === null || !Number.isInteger(id) || id > 128 || !/^GPU-[\w-]+$/.test(uuid ?? '')) return [];
    const matching = apps?.filter(row => row[0] === uuid && numeric(row[1]) !== null);
    const owned = matching?.filter(row => ownedPids.includes(Number(row[1])));
    const usedByOwned = owned?.map(row => numeric(row[2]));
    const hardwareThermal = active(heat), softwareThermal = active(softwareHeat);
    return [{ index: id, utilizationPct: numeric(util), memoryUtilizationPct: numeric(memUtil), usedMiB: numeric(used), totalMiB: numeric(total),
      smClockMHz: numeric(sm), memoryClockMHz: numeric(clock), powerWatts: numeric(watts), powerLimitWatts: numeric(limit), temperatureC: numeric(temp), pstate: numeric(state?.replace(/^P/, '')),
      powerLimited: active(power), thermalLimited: hardwareThermal === true || softwareThermal === true ? true : hardwareThermal === false && softwareThermal === false ? false : null,
      ownedComputeProcesses: owned?.length ?? null, otherComputeProcesses: matching && owned ? matching.length - owned.length : null,
      ownedComputeMiB: usedByOwned && usedByOwned.every(x => x !== null) ? usedByOwned.reduce<number>((sum, x) => sum + x!, 0) : null,
    }];
  });
  return { status: devices.length ? 'nvidia' : 'unavailable', hostFreeMiB: Math.round(memory.free / 2 ** 20), hostTotalMiB: Math.round(memory.total / 2 ** 20), devices };
}
type Command = (args: string[], signal: AbortSignal) => Promise<string | undefined>;
export class GpuTelemetry {
  constructor(private ownedPids: () => number[] = () => [], private command: Command = async (args, signal) => {
    try { return (await exec('nvidia-smi', args, { signal, timeout: 2500, windowsHide: true, maxBuffer: 65536, env: { ...process.env, LC_ALL: 'C' } })).stdout; } catch { return undefined; }
  }) {}
  async sample(signal: AbortSignal): Promise<GpuSample> {
    const query = async () => {
      const format = '--format=csv,noheader,nounits';
      let csv = await this.command(['--query-gpu=' + fields.join(','), format], signal);
      if (!csv && !signal.aborted) csv = await this.command(['--query-gpu=' + fields.slice(0, 12).join(','), format], signal);
      return csv ?? '';
    };
    const [csv, apps] = await Promise.all([query(), this.command(['--query-compute-apps=gpu_uuid,pid,used_gpu_memory', '--format=csv,noheader,nounits'], signal)]);
    return parseGpuSample(csv, apps, this.ownedPids());
  }
}
