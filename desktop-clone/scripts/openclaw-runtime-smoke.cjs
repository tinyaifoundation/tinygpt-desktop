const { spawn } = require('node:child_process');
const { resolve } = require('node:path');
const { join } = require('node:path');
const { mkdtemp, cp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
async function main() {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let portable;
  try {
    if (process.argv.includes('--portable-package')) {
      portable = await mkdtemp(join(tmpdir(), 'tinygpt-openclaw-portable-'));
      // Outside the repository: missing child dependencies cannot resolve upward
      // into the development node_modules tree and mask packaging omissions.
      await cp(resolve('release/openclaw-proof/win-unpacked/resources/openclaw'), join(portable, 'openclaw'), { recursive: true });
      env.TINYGPT_OPENCLAW_RESOURCE = join(portable, 'openclaw');
      env.TINYGPT_OPENCLAW_ASAR = resolve('release/openclaw-proof/win-unpacked/resources/app.asar');
      env.TINYGPT_OPENCLAW_PORTABLE_PROOF = '1';
    }
    await new Promise((done, reject) => {
      const child = spawn(resolve('node_modules/electron/dist/electron.exe'), [resolve('scripts/openclaw-runtime-smoke-main.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
      child.once('error', reject); child.once('exit', code => { process.exitCode = code ?? 1; done(); });
    });
  } finally { if (portable) await rm(portable, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
