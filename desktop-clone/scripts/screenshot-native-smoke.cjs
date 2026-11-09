const { build } = require('esbuild');
const { spawn } = require('node:child_process');
const { mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
(async () => {
  const entry = resolve('artifacts/screenshot-native-smoke-main.cjs');
  await build({ entryPoints: ['scripts/screenshot-native-smoke-main.ts'], outfile: entry, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
  const profile = resolve('.tools-smoke-profile', 'screenshot-native-' + Date.now()); mkdirSync(profile, { recursive: true });
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  // Launch normally: a Playwright debugger connection changes hidden-page painting.
  const child = spawn(resolve('node_modules/electron/dist/electron.exe'), [entry], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  const timer = setTimeout(() => { child.kill(); console.error('Screenshot regression timed out'); process.exitCode = 1; }, 30000);
  child.on('error', error => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
  child.on('exit', code => { clearTimeout(timer); if (code) process.exitCode = code; });
})().catch(error => { console.error(error); process.exitCode = 1; });
