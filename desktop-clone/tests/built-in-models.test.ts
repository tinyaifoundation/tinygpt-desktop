import { describe, expect, it } from 'vitest';
import { assessBuiltInHardware } from '../src/main/built-in-hardware';
import { managedLocalPins, managedServerArgs } from '../src/main/managed-local';
import { builtInModelId, builtInModelInfo } from '../src/shared/managed-local';
import { modelDisplayName } from '../src/shared/effort';

const GiB = 2 ** 30;
const device = (total = 16384, free = 14000, index = 0) => `NVIDIA test GPU, ${total}, ${free}, 8.6, 581.45, GPU-test-${index}, ${index}`;
describe('built-in hardware eligibility', () => {
  it('offers Pro only on a supported platform with enough host and dedicated device memory', () => {
    expect(assessBuiltInHardware('win32', 'x64', 32 * GiB, device()).proCompatible).toBe(true);
    expect(assessBuiltInHardware('darwin', 'arm64', 8 * GiB).includedSupported).toBe(true);
    for (const input of [assessBuiltInHardware('darwin', 'arm64', 64 * GiB, device()), assessBuiltInHardware('win32', 'arm64', 32 * GiB, device()), assessBuiltInHardware('win32', 'x64', 8 * GiB, device()), assessBuiltInHardware('win32', 'x64', 32 * GiB, device(12288, 12000))]) expect(input.proCompatible).toBe(false);
  });
  it('fails closed for missing, malformed, unsupported, or contradictory hardware reports', () => {
    for (const csv of [undefined, '', 'unreadable', device().replace('581.45', '535.00'), device().replace('8.6', '6.1'), device(16384, 20000), device().replace('16384', 'N/A')]) expect(assessBuiltInHardware('win32', 'x64', 32 * GiB, csv).proCompatible).toBe(false);
  });
  it('never sums adapters and selects an eligible single GPU', () => {
    expect(assessBuiltInHardware('win32', 'x64', 32 * GiB, device(8192, 7000, 0)+'\n'+device(8192, 7000, 1)).proCompatible).toBe(false);
    const result = assessBuiltInHardware('win32', 'x64', 32 * GiB, device(8192, 7000, 0)+'\n'+device(24576, 20000, 1));
    expect(result.device?.uuid).toBe('GPU-test-1'); expect(result.device?.totalBytes).toBe(24 * GiB);
  });
});
describe('built-in profiles', () => {
  it('keeps both identities friendly, including existing saved included-model selections', () => {
    expect(builtInModelId('MiniCPM5-2B')).toBe('included'); expect(modelDisplayName({ id: 'MiniCPM5-2B', name: 'MiniCPM5 2B · 64k' })).toBe('TinyGPT');
    expect(modelDisplayName({ id: 'tinygpt-pro', name: 'Ternary Bonsai 2' })).toBe('TinyGPT Pro');
    expect(builtInModelInfo('pro')).toMatchObject({ tools: true, images: false, contextWindowTokens: 65536, maxOutputTokens: 16384 });
  });
  it('pins the upstream-compatible Pro packing and isolates a full-context authenticated session', () => {
    expect(managedLocalPins.pro.url).toContain('94dd51cdbbec5309ed8b76a12f3268bc4fdceb93/Ternary-Bonsai-2-27B-Q2_0.gguf'); expect(managedLocalPins.pro.size).toBe(7626008928); expect(managedLocalPins.pro.sha256).toBe('4f99aed01b8a877e153f9aa6569a4440fe17c59701cc0953e36d7f460549e70e');
    const args = managedServerArgs('pro.gguf', 8123, 'key', 'CUDA', false, 'pro'), value = (key: string) => args[args.indexOf(key)+1];
    expect(value('--alias')).toBe('tinygpt-pro'); expect(value('--ctx-size')).toBe('65536'); expect(value('--parallel')).toBe('1'); expect(value('--n-predict')).toBe('16384'); expect(value('--split-mode')).toBe('none'); expect(value('--host')).toBe('127.0.0.1'); expect(value('--api-key-file')).toBe('key'); expect(value('--chat-template-kwargs')).toContain('medium');
  });
});
