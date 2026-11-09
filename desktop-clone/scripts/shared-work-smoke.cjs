const { build } = require('esbuild');
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');
const { mkdirSync, mkdtempSync, copyFileSync, existsSync } = require('node:fs');
(async () => {
  const main = resolve('out/main/shared-work-smoke.cjs');
  await build({ entryPoints: ['scripts/shared-work-smoke-main.ts'], outfile: main, bundle: true, platform: 'node', format: 'cjs', packages: 'external', loader: { '.png': 'file', '.ico': 'file' }, external: ['electron'] });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  mkdirSync(resolve('.tools-smoke-profile'), { recursive: true });
  env.TINYGPT_WORK_TEST_PROFILE = mkdtempSync(resolve('.tools-smoke-profile/shared-work-'));
  // safeStorage uses the profile's encrypted OS key. Copy that encrypted state
  // into the disposable profile; never open or mutate the active profile.
  if (env.TINYGPT_WORK_LIVE_PROFILE && existsSync(resolve(env.TINYGPT_WORK_LIVE_PROFILE, 'Local State'))) copyFileSync(resolve(env.TINYGPT_WORK_LIVE_PROFILE, 'Local State'), resolve(env.TINYGPT_WORK_TEST_PROFILE, 'Local State'));
  const result = spawnSync(require('electron'), [main], { env, windowsHide: true, stdio: 'inherit', timeout: 90000 });
  if (result.error) throw result.error; process.exitCode = result.status ?? 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
