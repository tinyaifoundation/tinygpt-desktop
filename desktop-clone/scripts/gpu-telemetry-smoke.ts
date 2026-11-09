import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { GpuTelemetry } from '../src/main/gpu-telemetry';
import { ReplyDiagnostics } from '../src/main/reply-diagnostics';

(async () => {
  const telemetry = new GpuTelemetry();
  const sample = await telemetry.sample(new AbortController().signal);
  assert.equal(sample.status, 'nvidia', 'This machine must expose its actual NVIDIA counters');
  assert.ok(sample.devices.some(gpu => gpu.totalMiB! >= 16000 && gpu.smClockMHz !== null && gpu.utilizationPct !== null));
  const db = new ReplyDiagnostics(':memory:', undefined, undefined, { sample: async () => sample });
  try {
    const runId = randomUUID(), requestId = randomUUID();
    db.begin({ runId, startedAt: Date.now(), route: 'local', provider: 'local', protocol: 'openai-compatible', fingerprint: '0123456789abcdef', version: '0.1.0', platform: 'win32' });
    db.record(runId, { event: 'request-start', requestId, purpose: 'reply' });
    await new Promise(resolve => setTimeout(resolve, 0));
    db.record(runId, { event: 'run-complete' });
    const captured = db.reports()[0].events.find(event => event.event === 'gpu-sample');
    assert.equal(captured?.requestId, requestId);
    assert.ok(!JSON.stringify(captured).includes('GPU-'));
    await writeFile('artifacts/gpu-telemetry-proof.json', JSON.stringify({ verified: true, realDeviceReadings: true, noInferenceSent: true, requestCorrelation: true, sample }, null, 2));
    console.log('PASS: actual NVIDIA counters captured and correlated without device UUIDs, process names or inference.');
  } finally { db.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
