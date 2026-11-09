const { build } = require('esbuild');
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');
const { mkdirSync, mkdtempSync } = require('node:fs');
(async () => {
  const main = resolve('out/main/built-in-harness-smoke.cjs');
  await build({ entryPoints: ['scripts/built-in-harness-smoke-main.ts'], outfile: main, bundle: true, platform: 'node', format: 'cjs', packages: 'external', loader: { '.png': 'file', '.ico': 'file' }, external: ['electron'] });
  mkdirSync(resolve('.tools-smoke-profile'), { recursive: true });
  const env = { ...process.env, TINYGPT_BUILT_IN_TEST_PROFILE: mkdtempSync(resolve('.tools-smoke-profile/built-in-harness-')) };
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  const result = spawnSync(require('electron'), [main], { env, windowsHide: true, stdio: 'inherit', timeout: 300000 });
  if (result.error) throw result.error; process.exitCode = result.status ?? 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
