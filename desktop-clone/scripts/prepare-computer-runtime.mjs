import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir, mkdtemp, readdir, copyFile, rm, chmod } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

// Build-time preparation only. Installed applications never download code.
const lock = JSON.parse(await readFile(new URL('./computer-runtime.json', import.meta.url), 'utf8'));
const target = `${process.platform}-${process.arch}`;
const asset = lock.targets[target];
if (!asset) throw Error(`Computer use is not bundled for ${target}.`);
const root = resolve('runtimes/computer');
const sdk = join(root, 'sdk');
const binary = process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver';
const packageFile = new URL('./computer-sdk/package.json', import.meta.url);
const packageLock = await readFile(new URL('./computer-sdk/package-lock.json', import.meta.url));
const dependencySha256 = createHash('sha256').update(packageLock).digest('hex');
async function hash(file) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}
await mkdir(root, { recursive: true });
try {
  const prepared = JSON.parse(await readFile(join(root, 'prepared.json'), 'utf8'));
  if (prepared.version === lock.version && prepared.target === target && prepared.archiveSha256 === asset.sha256 && prepared.dependencySha256 === dependencySha256 &&
      prepared.files?.length && (await Promise.all(prepared.files.map(async file => {
        const path = resolve(root, file.path);
        return path.startsWith(root + sep) && await hash(path) === file.sha256;
      }))).every(Boolean)) {
    console.log(`Cua Driver ${lock.version} verified (${target}).`);
    process.exit(0);
  }
} catch { /* Prepare an absent or incomplete runtime. */ }
const archive = join(root, asset.archive);
let valid = false;
try { valid = await hash(archive) === asset.sha256; } catch {}
if (!valid) {
  console.log(`Downloading pinned Cua Driver ${lock.version} (${target})…`);
  const response = await fetch(`https://github.com/trycua/cua/releases/download/cua-driver-rs-v${lock.version}/${asset.archive}`, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw Error(`Cua download returned HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw Error('Cua archive checksum mismatch.');
  await writeFile(archive, bytes);
}
const stage = await mkdtemp(join(root, 'prepare-'));
try {
  if (process.platform === 'win32') {
    const quote = value => `'${value.replaceAll("'", "''")}'`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(stage)}`], { windowsHide: true });
  } else execFileSync('tar', ['-xzf', archive, '-C', stage]);
  async function find(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isFile() && entry.name === binary) return path;
      if (entry.isDirectory()) { const found = await find(path); if (found) return found; }
    }
  }
  const source = await find(stage);
  if (!source) throw Error('Cua executable missing from its pinned release.');
  await copyFile(source, join(root, binary));
  if (process.platform !== 'win32') await chmod(join(root, binary), 0o755);
  await mkdir(sdk, { recursive: true });
  await copyFile(packageFile, join(sdk, 'package.json'));
  await writeFile(join(sdk, 'package-lock.json'), packageLock);
  const npm = process.env.npm_execpath;
  if (!npm) throw Error('Run npm run runtime:computer to prepare the isolated SDK.');
  execFileSync(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: sdk, windowsHide: true, stdio: 'inherit' });
  const sdkPackage = JSON.parse(await readFile(join(sdk, 'node_modules/@trycua/cua-driver/package.json'), 'utf8'));
  if (sdkPackage.version !== lock.version) throw Error('Cua SDK and executable versions do not match.');
  // Record every shipped SDK file, including the platform binding and its N-API runtime.
  const files = [{ path: binary, sha256: await hash(join(root, binary)) }];
  async function record(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw Error('Unexpected link in the isolated Cua SDK.');
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await record(path);
      else files.push({ path: path.slice(root.length + 1).replaceAll('\\', '/'), sha256: await hash(path) });
    }
  }
  await record(join(sdk, 'node_modules'));
  await writeFile(join(root, 'prepared.json'), JSON.stringify({ version: lock.version, target, sourceCommit: lock.sourceCommit, archiveSha256: asset.sha256, dependencySha256, files }, null, 2));
  console.log(`Prepared Cua Driver ${lock.version} (${target}); SDK isolated from the original desktop.`);
} finally {
  if (!resolve(stage).startsWith(root + sep)) throw Error('Unexpected Cua staging directory.');
  await rm(stage, { recursive: true, force: true });
}
