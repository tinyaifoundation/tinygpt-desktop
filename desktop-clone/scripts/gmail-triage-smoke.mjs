import { build } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
await mkdir('.tmp', { recursive: true });
let endpoint;
if (process.argv.includes('--live-local')) {
  const settings = JSON.parse(await readFile(resolve(process.env.APPDATA, 'TinyGPT Voice Clone/settings.json'), 'utf8'));
  const address = new URL(settings.local.endpoint);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname)) throw Error('The live check requires a loopback model endpoint.');
  endpoint = address.href;
}
await build({ entryPoints: ['scripts/gmail-triage-main.ts'], outfile: '.tmp/gmail-triage-main.mjs', bundle: true, platform: 'node', format: 'esm', packages: 'external', target: 'node24', plugins: process.argv.includes('--debug') ? [{ name: 'synthetic-errors-only', setup(builder) { builder.onLoad({ filter: /[\\/]core[\\/]librechat\.ts$/ }, async args => ({ contents: (await readFile(args.path, 'utf8')).replace('throw new Error(chatError(error));', 'throw error;'), loader: 'ts' })); } }] : [] });
const child = spawn(process.execPath, [resolve('.tmp/gmail-triage-main.mjs'), ...(endpoint ? [endpoint] : [])], { stdio: 'inherit', windowsHide: true });
child.on('exit', code => { process.exitCode = code ?? 1; });
