const { build } = require('esbuild');
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');
const { mkdirSync, mkdtempSync, copyFileSync, existsSync, readFileSync } = require('node:fs');
(async () => {
  const main = resolve(process.env.TINYGPT_PRO_CACHE_PROBE ? 'out/main/pro-cache-probe.cjs' : process.env.TINYGPT_PRO_CACHE_AUDIT ? 'out/main/pro-cache-audit.cjs' : 'out/main/pro-work-smoke.cjs');
  await build({ entryPoints: [process.env.TINYGPT_PRO_CACHE_PROBE ? 'scripts/pro-cache-probe-main.ts' : process.env.TINYGPT_PRO_CACHE_AUDIT ? 'scripts/pro-cache-audit-main.ts' : process.env.TINYGPT_PRO_BUDGET_SMOKE ? 'scripts/pro-work-budget-smoke-main.ts' : 'scripts/pro-work-smoke-main.ts'], outfile: main, platform: 'node', format: 'cjs', bundle: true, packages: 'external', external: ['electron'], loader: { '.png': 'file', '.ico': 'file' } });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  if (!env.TINYGPT_PRO_LIVE_PROFILE) throw Error('Set TINYGPT_PRO_LIVE_PROFILE to a profile with an already running local Pro connection.');
  mkdirSync('.tools-smoke-profile', { recursive: true }); env.TINYGPT_PRO_TEST_PROFILE = mkdtempSync(resolve('.tools-smoke-profile/pro-work-'));
  if (existsSync(resolve(env.TINYGPT_PRO_LIVE_PROFILE, 'Local State'))) copyFileSync(resolve(env.TINYGPT_PRO_LIVE_PROFILE, 'Local State'), resolve(env.TINYGPT_PRO_TEST_PROFILE, 'Local State'));
  const result = spawnSync(require('electron'), [main], { env, windowsHide: true, stdio: 'inherit', timeout: env.TINYGPT_PRO_WAIT_IDLE ? 1020000 : 420000 });
  if (result.error) throw result.error; process.exitCode = result.status ?? 1;
  if (env.TINYGPT_PRO_VISION_CACHE_TEST && result.status === 0 && JSON.parse(readFileSync(resolve('artifacts/gpu-vision-cache-proof.json'), 'utf8')).verified !== true) throw Error('The vision-cache regression exited before verification completed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
