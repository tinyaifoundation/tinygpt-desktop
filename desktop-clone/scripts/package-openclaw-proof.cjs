// A focused unsigned directory package: avoid unrelated UI dependency traversal.
const { mkdir, cp, writeFile } = require('node:fs/promises');
const { resolve, join } = require('node:path');
const { spawn } = require('node:child_process');
async function main() {
  const staging = resolve('artifacts/openclaw-proof-app');
  await mkdir(join(staging, 'out/main'), { recursive: true });
  await cp(resolve('out/main/openclaw-runtime.js'), join(staging, 'out/main/openclaw-runtime.js'));
  await cp(resolve('node_modules/ws'), join(staging, 'node_modules/ws'), { recursive: true });
  await cp(resolve('THIRD_PARTY_NOTICES.md'), join(staging, 'THIRD_PARTY_NOTICES.md'));
  await writeFile(join(staging, 'package.json'), JSON.stringify({ name: 'tinygpt-openclaw-proof', version: '0.1.0', main: 'out/main/openclaw-runtime.js', dependencies: { ws: '8.22.0' }, description: 'Isolated OpenClaw native runtime packaging proof' }, null, 2));
  await new Promise((done, reject) => {
    const child = spawn(process.execPath, [resolve('node_modules/electron-builder/out/cli/cli.js'), '--win', '--x64', '--dir', '--config.directories.app=artifacts/openclaw-proof-app', '--config.directories.output=release/openclaw-proof', '--config.productName=TinyGPT Runtime Proof'], { stdio: 'inherit', windowsHide: true });
    child.once('error', reject); child.once('exit', code => code === 0 ? done() : reject(new Error(`Runtime proof packaging exited ${code}`)));
  });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
