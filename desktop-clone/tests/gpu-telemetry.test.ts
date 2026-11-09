import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { parseGpuSample, GpuTelemetry } from '../src/main/gpu-telemetry';
import { nativePerformanceObserver } from '../src/core/native-performance';
import { ReplyDiagnostics } from '../src/main/reply-diagnostics';
import { traceEventSchema, type TraceMetadata } from '../src/shared/diagnostics';

const csv = '0, GPU-test-device, 83, 60, 18000, 24576, 1710, 9751, 302.1, 350, 72, P2, Active, Not Active, Not Active';
afterEach(() => vi.useRealTimers());

it('records useful GPU factors without process identities, paths or device UUIDs', () => {
  const sample = parseGpuSample(csv, 'GPU-test-device, 1234, 10000\nGPU-test-device, 5678, [N/A]', [1234]);
  expect(sample.devices[0]).toMatchObject({ utilizationPct: 83, powerWatts: 302.1, smClockMHz: 1710, pstate: 2, powerLimited: true, thermalLimited: false, ownedComputeProcesses: 1, otherComputeProcesses: 1, ownedComputeMiB: 10000 });
  expect(JSON.stringify(sample)).not.toMatch(/GPU-test|1234|5678/);
  expect(traceEventSchema.safeParse({ event: 'gpu-sample', gpu: sample }).success).toBe(true);
  expect(parseGpuSample(csv, 'GPU-test-device, 1234, [N/A]', [1234]).devices[0].ownedComputeMiB).toBeNull();
  expect(parseGpuSample(csv, undefined, []).devices[0].otherComputeProcesses).toBeNull();
});
it('falls back when optional counters are unsupported and distinguishes unavailable readings', async () => {
  const command = vi.fn(async (args: string[]) => args[0].startsWith('--query-compute') ? undefined : args[0].includes('clocks_event') ? undefined : csv.split(',').slice(0, 12).join(','));
  const sample = await new GpuTelemetry(() => [], command).sample(new AbortController().signal);
  expect(command).toHaveBeenCalledTimes(3); expect(sample.status).toBe('nvidia'); expect(sample.devices[0].powerLimited).toBeNull();
  expect(parseGpuSample('bad data', undefined, []).status).toBe('unavailable');
});
it('retains native generation, speculation and snapshot failure counters across fragmented log output only', () => {
  const metrics: any[] = [], observe = nativePerformanceObserver('pro', metric => metrics.push(metric));
  observe('PRIVATE_PATH_AND_KEY\nslot | task 17 | prompt eval ti');
  observe('me = 500.00 ms / 100 tokens\nslot | task 17 | eval time = 2000.00 ms / 60 tokens\n');
  observe('slot | task 17 | draft acceptance = 0.5 ( 20 accepted / 40 generated)\nprompt state size 4826.757 MiB exceeds cache size limit 4096.000 MiB, skipping\n');
  expect(metrics).toHaveLength(4);
  expect(metrics[1]).toMatchObject({ taskId: 17, stage: 'generation', tokensPerSecond: 30 });
  expect(metrics[2]).toMatchObject({ stage: 'speculation', accepted: 20, drafted: 40 });
  expect(metrics[3]).toMatchObject({ stage: 'cache-skip', cacheRequiredMiB: 4826.757 });
  expect(JSON.stringify(metrics)).not.toContain('PRIVATE');
  for (const metric of metrics) expect(traceEventSchema.safeParse({ event: 'runtime-metric', nativePerformance: metric }).success).toBe(true);
});

it('samples once for concurrent local runs, correlates requests, and stops on completion or disabling diagnostics', async () => {
  vi.useFakeTimers();
  const sampler = { sample: vi.fn(async () => parseGpuSample(csv, '', [])) }, db = new ReplyDiagnostics(':memory:', Date.now, Date.now, sampler);
  const meta = (): TraceMetadata => ({ runId: randomUUID(), startedAt: Date.now(), route: 'local', provider: 'local', protocol: 'openai-compatible', fingerprint: '0123456789abcdef', version: '0.1.0', platform: 'win32' });
  try {
    const a = meta(), b = meta(), requestId = randomUUID(); db.begin(a); db.begin(b);
    db.record(a.runId, { event: 'request-start', requestId, purpose: 'reply' });
    await vi.advanceTimersByTimeAsync(0);
    expect(sampler.sample).toHaveBeenCalledTimes(1);
    expect(db.reports().find(r => r.runId === a.runId)?.events).toContainEqual(expect.objectContaining({ event: 'gpu-sample', requestId }));
    db.record(a.runId, { event: 'run-complete' }); await vi.advanceTimersByTimeAsync(10000); expect(sampler.sample).toHaveBeenCalledTimes(2);
    db.setEnabled(false); await vi.advanceTimersByTimeAsync(20000); expect(sampler.sample).toHaveBeenCalledTimes(2);
  } finally { db.close(); }
});
it('does not poll for cloud work and drops late samples after clear', async () => {
  vi.useFakeTimers(); let deliver!: (sample: ReturnType<typeof parseGpuSample>) => void;
  const sampler = { sample: vi.fn(() => new Promise<ReturnType<typeof parseGpuSample>>(resolve => deliver = resolve)) }, db = new ReplyDiagnostics(':memory:', Date.now, Date.now, sampler);
  try {
    const common = { startedAt: Date.now(), protocol: 'openai-compatible', fingerprint: '0123456789abcdef', version: '0.1.0', platform: 'win32' } as const;
    db.begin({ ...common, runId: randomUUID(), route: 'byok', provider: 'openrouter' }); expect(sampler.sample).not.toHaveBeenCalled();
    db.begin({ ...common, runId: randomUUID(), route: 'local', provider: 'local' }); expect(sampler.sample).toHaveBeenCalledOnce();
    db.clear(); deliver(parseGpuSample(csv, '', [])); await vi.advanceTimersByTimeAsync(20000);
    expect(db.reports()).toHaveLength(0); expect(sampler.sample).toHaveBeenCalledOnce();
  } finally { db.close(); }
});
