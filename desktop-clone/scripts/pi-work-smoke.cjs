const { build } = require('esbuild');
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');
const { mkdirSync, mkdtempSync, copyFileSync, existsSync } = require('node:fs');
(async () => {
  const main = resolve('out/main/pi-work-smoke.cjs');
  await build({ entryPoints: ['scripts/pi-work-smoke-main.ts'], outfile: main, bundle: true, platform: 'node', format: 'cjs', packages: 'external', loader: { '.png': 'file', '.ico': 'file' }, external: ['electron'] });
  mkdirSync(resolve('.tools-smoke-profile'), { recursive: true });
  const env = { ...process.env, TINYGPT_PI_TEST_PROFILE: mkdtempSync(resolve('.tools-smoke-profile/pi-work-')) };
  if (env.TINYGPT_PI_LIVE_PROFILE && existsSync(resolve(env.TINYGPT_PI_LIVE_PROFILE, 'Local State'))) copyFileSync(resolve(env.TINYGPT_PI_LIVE_PROFILE, 'Local State'), resolve(env.TINYGPT_PI_TEST_PROFILE, 'Local State'));
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  const result = spawnSync(require('electron'), [main], { env, windowsHide: true, stdio: 'inherit', timeout: env.TINYGPT_PI_LIVE_PROFILE ? 300000 : 180000 });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
