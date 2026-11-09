import { describe, expect, it } from 'vitest';
import { macGraphics, macMemory, nvidiaReadings, windowsComponents } from '../src/main/configuration-monitor';
import { builtInAvailability, type ManagedLocalStatus } from '../src/shared/managed-local';

describe('built-in availability', () => {
  const status = (phase: ManagedLocalStatus['phase'], ready = true): ManagedLocalStatus => ({ phase, ready, installed: true, message: 'Fixture' });
  it('distinguishes the selected running built-in from an installed idle model', () => {
    expect(builtInAvailability(status('running'), true, true)).toBe('Active');
    expect(builtInAvailability(status('running'), false, true)).toBe('Ready');
    expect(builtInAvailability(status('idle'), true, true)).toBe('Ready');
    expect(builtInAvailability(status('idle'), false, true)).toBe('Ready');
  });
  it('never marks incomplete, failed, incompatible or transitional setups as ready', () => {
    expect(builtInAvailability(status('idle', false), false, true)).toBeUndefined();
    expect(builtInAvailability(status('idle'), false, false)).toBeUndefined();
    expect(builtInAvailability(undefined, false, true)).toBeUndefined();
    for (const phase of ['downloading', 'verifying', 'extracting', 'starting', 'stopping', 'error'] as const) expect(builtInAvailability(status(phase), true, true)).toBeUndefined();
  });
});

describe('device monitor readings', () => {
  it('keeps graphics cards separate and preserves unavailable readings instead of making up zeros', () => {
    const readings = nvidiaReadings('0, GPU-one, NVIDIA One, 24576, 2918, 31, 47\n1, GPU-two, NVIDIA Two, 8192, 1000, [N/A], N/A');
    expect(readings).toHaveLength(2);
    expect(readings[0]).toMatchObject({ totalBytes: 24576 * 2 ** 20, usedBytes: 2918 * 2 ** 20, activity: 31, temperature: 47 });
    expect(readings[1]).toMatchObject({ totalBytes: 8192 * 2 ** 20, activity: null, temperature: null });
    expect(nvidiaReadings('driver unavailable')).toEqual([]);
    expect(nvidiaReadings('0, GPU-one, NVIDIA One, 100, 101, 101, -1')[0]).toMatchObject({ usedBytes: null, activity: null, temperature: null });
  });
  it('attributes only owned processes and does not fold overlapping allocations into device totals', () => {
    const result = windowsComponents([{ id: 'pro', name: 'TinyGPT Pro', pids: [42], state: 'Active' }, { id: 'included', name: 'TinyGPT', pids: [], state: 'Not loaded' }], { processes: [{ pid: 42, memory: 200 }], graphics: [{ pid: 42, dedicated: 300, shared: 5 }, { pid: 77, dedicated: 9999, shared: 0 }] });
    expect(result[0]).toMatchObject({ memoryBytes: 200, graphicsBytes: 300 });
    expect(result[1]).toMatchObject({ memoryBytes: 0, graphicsBytes: 0 });
    expect(windowsComponents([{ id: 'pro', name: 'TinyGPT Pro', pids: [42], state: 'Active' }], null)[0]).toMatchObject({ memoryBytes: null, graphicsBytes: null });
  });
  it('uses the actual Mac page size and excludes purgeable pages from memory in use', () => {
    const vm = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nAnonymous pages: 1000.\nPages wired down: 200.\nPages occupied by compressor: 50.\nPages purgeable: 25.';
    expect(macMemory(vm, 32 * 2 ** 30)?.usedBytes).toBe(1225 * 16384);
    expect(macMemory(vm.replace('16384', '4096'), 32 * 2 ** 30)?.usedBytes).toBe(1225 * 4096);
    expect(macMemory('Unavailable', 32 * 2 ** 30)).toBeUndefined();
    expect(macGraphics('', 'Apple M2')[0]).toMatchObject({ totalBytes: null, usedBytes: null, activity: null, temperature: null });
    expect(macGraphics('"Device Utilization %"=28,"Temperature(C)"=48', 'Apple M2')[0]).toMatchObject({ activity: 28, temperature: 48 });
  });
});
