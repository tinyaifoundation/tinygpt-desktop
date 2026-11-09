import { app } from 'electron';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join, basename, delimiter } from 'node:path';
import assert from 'node:assert/strict';
import { managedLocalPins, managedServerArgs } from '../src/main/managed-local';
import { analyzeProImage } from '../src/main/pro-vision';
import { LocalVisionService } from '../src/main/local-vision';
import { ToolBroker } from '../src/main/tool-broker';
import { HistoryStore } from '../src/main/history';
import { ProjectFiles } from '../src/main/files';
import { defaultSettings } from '../src/shared/config';
import { imageReference } from '../src/shared/vision';
import type { BrowserController } from '../src/main/browser';

app.setPath('userData', process.env.TINYGPT_PRO_VISION_TEST_PROFILE!);
app.whenReady().then(async () => {
  const profile = app.getPath('userData'), cache = resolve('.tools-smoke-profile/builtins'), runtime = join(cache, 'runtime/llama-b11960-CUDA');
  const server = createServer(); await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const port = (server.address() as { port: number }).port; await new Promise<void>(done => server.close(() => done()));
  const key = randomBytes(32).toString('hex'), keyFile = join(profile, 'server.key'); await writeFile(keyFile, key);
  const mtp = process.env.TINYGPT_TEST_MTP === '1';
  const args = managedServerArgs(join(cache, 'pro', basename(new URL(managedLocalPins.pro.url).pathname)), port, keyFile, 'CUDA', mtp, 'pro', join(cache, 'pro', basename(new URL(managedLocalPins.proVision.url).pathname)), mtp ? { mtpModel: join(cache, 'pro', basename(new URL(managedLocalPins.proMtp.url).pathname)) } : {});
  // Leave GPU memory for the user's active app. The same weights and 64K slot
  // run with partial offload only in this smoke test; production keeps 99 layers.
  const gpuLayers = mtp ? 99 : 48;
  args[args.indexOf('--n-gpu-layers') + 1] = String(gpuLayers);
  const child = spawn(join(runtime, 'llama-server.exe'), args, { cwd: runtime, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: runtime + delimiter + process.env.PATH } });
  let logs = ''; child.stdout?.on('data', data => { logs = (logs + data).slice(-2500); }); child.stderr?.on('data', data => { logs = (logs + data).slice(-2500); });
  const endpoint = `http://127.0.0.1:${port}/v1`, history = new HistoryStore(join(profile, 'library.sqlite'));
  const settings = structuredClone(defaultSettings); settings.toolPermissions.read = 'allow';
  const broker = new ToolBroker(history, () => settings, { partition: () => 'fixture', shutdown() {} } as unknown as BrowserController, new ProjectFiles(history.sources), () => {});
  let smallerLoads = 0;
  const small = new LocalVisionService({ modelRoot: '', runtimeRoot: '', stateRoot: profile, load: async () => { smallerLoads++; throw Error('The smaller image model must not load for Pro.'); } });
  broker.localVision = small;
  broker.proVision = { available: () => child.exitCode === null, analyze: (image, question, signal) => analyzeProImage(endpoint, key, image, question, signal) };
  try {
    const until = Date.now() + 90000;
    while (true) {
      if (child.exitCode !== null || Date.now() > until) throw Error('Pro vision server failed to start. ' + logs);
      try { if ((await fetch(endpoint.replace('/v1', '/health'), { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
      await new Promise(done => setTimeout(done, 200));
    }
    const chat = history.createConversation(null, 'chat'), png = await readFile('artifacts/vision-status.png');
    const source = history.sources.add(chat.id, { kind: 'image', title: 'Status fixture', text: '', image: 'data:image/png;base64,' + png.toString('base64'), originalImage: png });
    const result = JSON.parse(await broker.execute({ conversationId: chat.id, runId: randomUUID(), signal: AbortSignal.timeout(120000), vision: false, imageModel: 'pro' }, { id: randomUUID(), name: 'view_image', input: { image: imageReference(source.id), question: 'Read the large heading and the speed shown, including its number.' } }));
    console.log(JSON.stringify(result, null, 2));
    assert.equal(result.model, 'TinyGPT Pro'); assert.equal(result.incomplete, false); assert.match(result.observation, /TASK COMPLETE/i); assert.match(result.observation, /42/); assert.equal(smallerLoads, 0);
    assert.ok(!JSON.stringify(result).includes('base64'));
    await writeFile('artifacts/pro-vision-proof.json', JSON.stringify({ verified: true, context: 65536, mtp, testGpuLayers: gpuLayers, smallerModelLoads: smallerLoads, result }, null, 2));
  } finally {
    await broker.shutdown(); history.close();
    if (child.exitCode === null) { const done = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill(); await done; }
  }
}).then(() => app.quit(), error => { console.error(error.message); app.exit(1); });
