import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, readdir, copyFile, chmod, rm } from 'node:fs/promises';
import { resolve, join, sep, basename } from 'node:path';
import { execFileSync } from 'node:child_process';

const pins = JSON.parse(await readFile(new URL('./work-tools.json', import.meta.url), 'utf8'));
const target = `${process.platform}-${process.arch}`, root = resolve('runtimes/work-tools');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
await mkdir(root, { recursive: true });
try {
  const saved = JSON.parse(await readFile(join(root, 'prepared.json'), 'utf8'));
  if (saved.target === target && saved.pins === hash(JSON.stringify(pins)) && (await Promise.all(saved.files.map(async file => hash(await readFile(join(root, file.path))) === file.sha256))).every(Boolean)) { console.log(`Work search tools verified (${target}).`); process.exit(0); }
} catch { /* Prepare missing helpers at build time only. */ }
const files = [];
for (const [tool, pin] of Object.entries(pins)) {
  const asset = pin.targets[target]; if (!asset) throw new Error(`Work tools are not prepared for ${target}.`);
  const archive = join(root, basename(new URL(asset.url).pathname));
  let bytes; try { bytes = await readFile(archive); } catch {}
  if (!bytes || hash(bytes) !== asset.sha256) { const response = await fetch(asset.url, { signal: AbortSignal.timeout(120000) }); if (!response.ok) throw new Error(`Tool download returned ${response.status}.`); bytes = Buffer.from(await response.arrayBuffer()); if (hash(bytes) !== asset.sha256) throw new Error('Work tool checksum mismatch.'); await writeFile(archive, bytes); }
  const stage = await mkdtemp(join(root, 'stage-'));
  try {
    if (process.platform === 'win32') { const quote = text => `'${text.replaceAll("'", "''")}'`; execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(stage)}`], { windowsHide: true }); }
    else execFileSync('tar', ['-xzf', archive, '-C', stage], { windowsHide: true });
    const binary = tool + (process.platform === 'win32' ? '.exe' : ''); let found = false;
    async function collect(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name); if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await collect(path);
        else if (entry.name === binary || /^(LICENSE|COPYING|UNLICENSE)/i.test(entry.name)) {
          const relative = entry.name === binary ? binary : join('licenses', tool, entry.name); await mkdir(join(root, 'licenses', tool), { recursive: true }); await copyFile(path, join(root, relative));
          if (entry.name === binary) { found = true; if (process.platform !== 'win32') await chmod(join(root, relative), 0o755); }
          files.push({ path: relative.replaceAll('\\', '/'), sha256: hash(await readFile(path)) });
        }
      }
    }
    await collect(stage); if (!found) throw new Error(`${tool} executable missing from release.`);
  } finally { if (!resolve(stage).startsWith(root + sep)) throw new Error('Invalid preparation folder.'); await rm(stage, { recursive: true, force: true }); }
}
await writeFile(join(root, 'prepared.json'), JSON.stringify({ target, pins: hash(JSON.stringify(pins)), files }, null, 2));
console.log(`Prepared pinned Work search tools (${target}).`);
