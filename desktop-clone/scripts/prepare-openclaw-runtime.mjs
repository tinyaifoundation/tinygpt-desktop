// Build-time only: the shipped app never downloads or installs a runtime.
import { readFile, writeFile, mkdir, chmod, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'runtimes', 'openclaw');
const release = JSON.parse(await readFile(join(root, 'node-release.json'), 'utf8'));
const target = `${process.platform}-${process.arch}`;
const selected = release.targets[target];
if (!selected) throw new Error(`Unsupported OpenClaw build target: ${target}`);
const npmCli = process.env.npm_execpath ?? process.argv[2];
if (!npmCli) throw new Error('Run through npm run runtime:openclaw, or pass the npm CLI path.');
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
if (Object.entries(lock.packages).some(([path, entry]) => path && (!path.startsWith('node_modules/') || entry.link))) throw new Error('The private runtime lockfile must not link external project directories.');
function run(executable, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Runtime preparation exited ${code}`)));
  });
}
await run(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { ...process.env, PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` });
const require = createRequire(join(root, 'package.json'));
const destination = join(root, 'node');
await mkdir(destination, { recursive: true });
const archivePath = join(root, selected.archive);
let archive;
try { archive = await readFile(archivePath); } catch {
  const response = await fetch(`https://nodejs.org/dist/v${release.version}/${selected.archive}`, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Node download failed: HTTP ${response.status}`);
  archive = Buffer.from(await response.arrayBuffer());
}
if (createHash('sha256').update(archive).digest('hex') !== selected.sha256) throw new Error('Official Node archive checksum mismatch.');
await writeFile(archivePath, archive);
if (target.startsWith('win32-')) {
  const zip = await require('jszip').loadAsync(archive);
  const top = selected.archive.slice(0, -4);
  for (const name of ['node.exe', 'LICENSE']) {
    const file = zip.file(`${top}/${name}`); if (!file) throw new Error(`Missing Node ${name}`);
    await writeFile(join(destination, name), await file.async('nodebuffer'));
  }
} else {
  await require('tar').x({ file: archivePath, cwd: destination, strip: 1, filter: path => /\/(bin\/node|LICENSE)$/.test(path) });
  await chmod(join(destination, 'bin', 'node'), 0o755);
}
const executable = join(destination, process.platform === 'win32' ? 'node.exe' : 'bin/node');
// Finish upstream's package lifecycle at build time, never in a read-only app bundle.
const env = { ...process.env, OPENCLAW_NO_RESPAWN: '1', OPENCLAW_EXEC_SHELL_SNAPSHOT: '0' };
await run(executable, [join(root, 'node_modules/openclaw/openclaw.mjs'), '--version'], env);
try { await access(join(root, 'node_modules/openclaw/.openclaw-lifecycle-pending')); throw new Error('OpenClaw package lifecycle is still pending.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
await writeFile(join(root, 'prepared.json'), JSON.stringify({ openclaw: '2026.9.9', node: release.version, target, archiveSha256: selected.sha256 }, null, 2) + '\n');
await import('./openclaw-license-inventory.mjs');
console.log(`Prepared OpenClaw 2026.9.9 with official Node ${release.version} for ${target}.`);
