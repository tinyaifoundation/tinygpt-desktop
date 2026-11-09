import { describe, expect, it } from 'vitest';
import { promptCacheMiB, proRequiredFreeBytes, managedPerformanceEnv } from '../src/main/managed-performance';
import { managedServerArgs, managedLocalPins } from '../src/main/managed-local';
import { defaultSettings, settingsSchema } from '../src/shared/config';

describe('Pro acceleration', () => {
  it('bounds lazy host caching while reserving memory for the app and tools', () => {
    expect(promptCacheMiB(4 * 2 ** 30)).toBe(0);
    expect(promptCacheMiB(8 * 2 ** 30)).toBe(2048);
    expect(promptCacheMiB(16 * 2 ** 30)).toBe(6144);
    expect(promptCacheMiB(128 * 2 ** 30)).toBe(16384);
    for (const free of [5, 8, 12, 16, 32, 128]) expect(promptCacheMiB(free * 2 ** 30)).toBeLessThanOrEqual((free - 4) * 1024 / 2);
    expect(promptCacheMiB(16 * 2 ** 30)).toBeGreaterThan(4827);
  });
  it('requires the separate pinned head and fully offloads MTP without changing target identity or context', () => {
    expect(proRequiredFreeBytes(true)).toBeGreaterThan(proRequiredFreeBytes(false) + 1.5 * 2 ** 30);
    expect(() => managedServerArgs('target', 1234, 'key', 'CUDA', true, 'pro')).toThrow('prediction support');
    const args = managedServerArgs('target', 1234, 'key', 'CUDA', true, 'pro', 'vision', { mtpModel: 'prediction', cacheMiB: 2048 });
    const value = (key: string) => args[args.indexOf(key) + 1];
    expect(value('--model')).toBe('target'); expect(value('--alias')).toBe('tinygpt-pro'); expect(value('--ctx-size')).toBe('65536');
    expect(value('--spec-type')).toBe('draft-mtp'); expect(value('--spec-draft-model')).toBe('prediction'); expect(value('--spec-draft-n-max')).toBe('1'); expect(value('--spec-draft-ngl')).toBe('99');
    expect(value('--cache-ram')).toBe('2048'); expect(value('--spec-draft-type-k')).toBe('q8_0'); expect(value('--mmproj')).toBe('vision');
    expect(value('--host')).toBe('127.0.0.1'); expect(value('--api-key-file')).toBe('key');
    expect(managedLocalPins.proMtp.url).toContain('/resolve/a316ea527fde32c12487be7574e2db5ac2ad2a7e/');
    expect(managedLocalPins.proMtp.size).toBe(1680271776); expect(managedLocalPins.proMtp.sha256).toHaveLength(64);
  });
  it('keeps experimental options opt-in and preserves the included model path', () => {
    const args = managedServerArgs('target', 1234, 'key', 'CUDA');
    expect(args).not.toContain('--backend-sampling'); expect(managedPerformanceEnv()).toEqual({});
    expect(managedPerformanceEnv({ graphConcurrency: true })).toEqual({ GGML_CUDA_GRAPH_OPT: '1' });
    expect(managedServerArgs('target', 1234, 'key', 'Vulkan', true)).toContain('ngram-simple');
    expect(managedServerArgs('target', 1234, 'key', 'CUDA', false, 'pro')).toContain('none');
  });
  it('migrates the acceleration preference and preserves an explicit opt-out', () => {
    const { builtIn: _, ...legacy } = defaultSettings;
    expect(settingsSchema.parse(legacy).builtIn.proMtp).toBe(true);
    expect(settingsSchema.parse({ ...legacy, builtIn: { proMtp: false } }).builtIn.proMtp).toBe(false);
  });
});
