const { buildSync } = require('esbuild');
const { spawnSync } = require('node:child_process');
const { resolve, join, basename } = require('node:path');
const { mkdirSync, mkdtempSync } = require('node:fs');
(async () => {
  const cache = resolve('.tools-smoke-profile/builtins'); mkdirSync(cache, { recursive: true });
  const modulePath = join(cache, 'vision-managed.cjs');
  buildSync({ entryPoints: ['src/main/managed-local.ts'], outfile: modulePath, bundle: true, platform: 'node', format: 'cjs' });
  const { ManagedLocalModel, managedLocalPins } = require(modulePath);
  const owner = new ManagedLocalModel(join(cache, 'pro'), undefined, 'pro', join(cache, 'runtime'));
  const pin = managedLocalPins.proVision;
  // Exercise the same resumable, hash-verified downloader used by setup.
  const timer = setInterval(() => { const state = owner.status(); if (state.total) console.log(`Image support ${Math.floor((state.downloaded || 0) / state.total * 100)}%`); }, 10000);
  try { await owner.download(pin.url, join(cache, 'pro', basename(new URL(pin.url).pathname)), pin.size, pin.sha256, AbortSignal.timeout(600000), 'Pro image support'); } finally { clearInterval(timer); }
  if (process.env.TINYGPT_TEST_MTP === '1') {
    const prediction = managedLocalPins.proMtp;
    await owner.download(prediction.url, join(cache, 'pro', basename(new URL(prediction.url).pathname)), prediction.size, prediction.sha256, AbortSignal.timeout(600000), 'Pro prediction support');
  }
  const main = resolve('out/main/pro-vision-smoke.cjs');
  buildSync({ entryPoints: ['scripts/pro-vision-smoke-main.ts'], outfile: main, bundle: true, platform: 'node', format: 'cjs', packages: 'external', loader: { '.png': 'file', '.ico': 'file' }, external: ['electron'] });
  const env = { ...process.env, TINYGPT_PRO_VISION_TEST_PROFILE: mkdtempSync(resolve('.tools-smoke-profile/pro-vision-')) }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  const result = spawnSync(require('electron'), [main], { env, windowsHide: true, stdio: 'inherit', timeout: 240000 });
  if (result.error) throw result.error; process.exitCode = result.status ?? 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
