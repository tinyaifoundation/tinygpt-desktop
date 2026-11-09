import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

// Run npm run runtime:dictation, then put NVIDIA's
// test_files/asr/wav/test/jfk.wav into artifacts/dictation-research.
// This checks actual cache-aware inference using the model bundled with the app.
const root = resolve('artifacts/dictation-research');
const bundled = join(root, 'service.cjs');
await build({ entryPoints: ['src/main/dictation-service.ts'], outfile: bundled, bundle: true, platform: 'node', format: 'cjs', external: ['ws', 'electron'] });
const { DictationService } = createRequire(import.meta.url)(bundled);
const bytes = await readFile(join(root, 'jfk.wav'));
assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
let rate = 0, channels = 0, bits = 0, pcm;
for (let offset = 12; offset + 8 <= bytes.length;) {
  const type = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4), data = offset + 8;
  if (type === 'fmt ') { assert.equal(bytes.readUInt16LE(data), 1); channels = bytes.readUInt16LE(data + 2); rate = bytes.readUInt32LE(data + 4); bits = bytes.readUInt16LE(data + 14); }
  if (type === 'data') pcm = bytes.subarray(data, data + length);
  offset = data + length + length % 2;
}
assert.equal(channels, 1); assert.equal(bits, 16); assert.ok(pcm);
const events = [];
const owner = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: (_channel, event) => { events.push(event); if (event.text !== undefined) console.log(event.phase, event.text); } });
const service = new DictationService(resolve('runtimes/dictation'));
try {
  const id = randomUUID(); await service.start(id, rate, owner);
  const frameBytes = Math.round(rate * 0.08) * 2;
  for (let offset = 0; offset < pcm.length; offset += frameBytes) { service.audio(id, owner, pcm.subarray(offset, offset + frameBytes)); await delay(80); }
  await service.stop(id, owner, false);
  const updates = events.filter(event => event.text !== undefined);
  assert.ok(updates.length > 2, 'Expected incremental streaming text');
  assert.match(updates.at(-1).text, /ask not/i);
  assert.equal(events.at(-1).phase, 'stopped');
  const report = { passed: true, sampleRate: rate, streamingUpdates: updates.length, transcript: updates.at(-1).text };
  await writeFile(join(root, 'native-result.json'), JSON.stringify(report, null, 2));
  console.log(report);
} finally { service.close(); }
