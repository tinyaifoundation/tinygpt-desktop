const { build } = require('esbuild');
const { spawn } = require('node:child_process');
const { mkdirSync, mkdtempSync, copyFileSync } = require('node:fs');
const { resolve } = require('node:path');
(async () => {
  const verify = process.argv.includes('--verify');
  const main = resolve(`out/main/opencode-dashboard-${verify ? 'verify' : 'smoke'}.cjs`);
  await build({ entryPoints: [`scripts/opencode-dashboard-${verify ? 'verify' : 'smoke'}-main.ts`], outfile: main, bundle: true, platform: 'node', format: 'cjs', packages: 'external', loader: { '.png': 'file', '.ico': 'file' }, external: ['electron'] });
  mkdirSync('.tools-smoke-profile', { recursive: true });
  const env = { ...process.env, TINYGPT_PI_TEST_PROFILE: process.env.TINYGPT_DASHBOARD_RESUME_PROFILE || mkdtempSync(resolve('.tools-smoke-profile/opencode-dashboard-')) };
  if (env.TINYGPT_PI_LIVE_PROFILE) copyFileSync(resolve(env.TINYGPT_PI_LIVE_PROFILE, 'Local State'), resolve(env.TINYGPT_PI_TEST_PROFILE, 'Local State'));
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  const child = spawn(require('electron'), [main], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
})().catch(error => { console.error(error); process.exitCode = 1; });
