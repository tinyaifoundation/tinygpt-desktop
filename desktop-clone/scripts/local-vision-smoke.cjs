const { build } = require('esbuild');
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');
const { mkdirSync, mkdtempSync, copyFileSync, existsSync } = require('node:fs');
(async () => {
  const main = resolve('out/main/local-vision-smoke.cjs');
  await build({ entryPoints: ['scripts/local-vision-smoke-main.ts'], outfile: main, platform: 'node', format: 'cjs', bundle: true, packages: 'external', external: ['electron'], loader: { '.png': 'file', '.ico': 'file' } });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  mkdirSync('.tools-smoke-profile', { recursive: true });
  env.TINYGPT_VISION_TEST_PROFILE = mkdtempSync(resolve('.tools-smoke-profile/vision-'));
  if (env.TINYGPT_VISION_LIVE_PROFILE && existsSync(resolve(env.TINYGPT_VISION_LIVE_PROFILE, 'Local State'))) copyFileSync(resolve(env.TINYGPT_VISION_LIVE_PROFILE, 'Local State'), resolve(env.TINYGPT_VISION_TEST_PROFILE, 'Local State'));
  const result = spawnSync(require('electron'), [main], { env, windowsHide: true, stdio: 'inherit', timeout: 240000 });
  if (result.error) throw result.error; process.exitCode = result.status ?? 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
