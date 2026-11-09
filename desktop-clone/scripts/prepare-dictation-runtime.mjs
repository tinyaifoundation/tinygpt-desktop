import { readFile, writeFile, mkdir, rename, rm, access, stat, copyFile, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const manifest = JSON.parse(await readFile(new URL('./dictation-runtime.json', import.meta.url), 'utf8'));
const target = `${process.platform}-${process.arch}`;
const asset = manifest.targets[target];
if (!asset) throw new Error(`On-device dictation does not yet support ${target}.`);
const root = fileURLToPath(new URL('../runtimes/dictation/', import.meta.url));
const folder = asset.archive.replace(/\.(zip|tar\.gz)$/, '');
const executable = join(folder, 'bin', process.platform === 'win32' ? 'nemo-speech.exe' : 'nemo-speech');
async function prepareRuntime() {
try {
  const prepared = JSON.parse(await readFile(join(root, 'prepared.json'), 'utf8'));
  if (prepared.target === target && prepared.sha256 === asset.sha256) { await access(join(root, executable)); console.log('Dictation runtime is ready.'); return; }
} catch {}
await mkdir(root, { recursive: true });
const staging = join(root, `staging-${randomUUID()}`);
await mkdir(staging);
try {
  console.log(`Preparing NVIDIA NeMo-Speech ${manifest.version} for ${target}…`);
  const response = await fetch(`https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v${manifest.version}/${asset.archive}`, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Runtime download returned ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('Runtime checksum mismatch.');
  const archive = join(staging, asset.archive); await writeFile(archive, bytes);
  if (process.platform === 'win32') {
    const quote = value => `'${value.replaceAll("'", "''")}'`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(staging)}`], { windowsHide: true });
  } else execFileSync('tar', ['-xzf', archive, '-C', staging]);
  await access(join(staging, executable));
  // Only replace a verified, fixed runtime directory under this project.
  const destination = resolve(root, folder);
  if (!destination.startsWith(resolve(root) + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('Invalid runtime destination.');
  await rm(destination, { recursive: true, force: true });
  await rename(join(staging, folder), destination);
  await writeFile(join(root, 'prepared.json'), JSON.stringify({ target, version: manifest.version, sha256: asset.sha256, executable }, null, 2));
  console.log('Dictation runtime is ready.');
} finally {
  if (!resolve(staging).startsWith(resolve(root) + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('Invalid staging directory.');
  await rm(staging, { recursive: true, force: true });
}
}

async function prepareModel() {
  const model = JSON.parse(await readFile(new URL('../src/shared/dictation-model.json', import.meta.url), 'utf8'));
  const models = join(root, 'models'); await mkdir(models, { recursive: true });
  const destination = join(models, model.file);
  async function valid(path) {
    try {
      if ((await stat(path)).size !== model.size) return false;
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      return hash.digest('hex') === model.sha256;
    } catch { return false; }
  }
  if (!await valid(destination)) {
    const temporary = `${destination}.${randomUUID()}.part`;
    try {
      // Reuse an already verified development sample download if present.
      const developmentModel = fileURLToPath(new URL('../artifacts/dictation-research/model.gguf', import.meta.url));
      if (await valid(developmentModel)) await copyFile(developmentModel, temporary);
      else {
        console.log('Downloading the bundled Nemotron 3.5 ASR model (742 MB)…');
        const response = await fetch(`https://huggingface.co/${model.repo}/resolve/${model.revision}/${model.file}`, { signal: AbortSignal.timeout(30 * 60_000) });
        if (!response.ok || !response.body) throw new Error(`Model download returned ${response.status}.`);
        const file = await open(temporary, 'wx'); let size = 0;
        try {
          for await (const chunk of response.body) {
            size += chunk.length; if (size > model.size) throw new Error('Model download exceeds pinned size.');
            await file.writeFile(chunk);
          }
        } finally { await file.close(); }
      }
      if (!await valid(temporary)) throw new Error('Bundled dictation model checksum mismatch.');
      await rename(temporary, destination);
    } finally { await rm(temporary, { force: true }); }
  }
  const licensePath = join(models, 'OpenMDW-1.1.html');
  try { await access(licensePath); } catch {
    const response = await fetch('https://openmdw.ai/license/1-1/', { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Model license download returned ${response.status}.`);
    await writeFile(licensePath, await response.text());
  }
  const cardPath = join(models, 'MODEL_CARD.md');
  try { await access(cardPath); } catch {
    const response = await fetch(`https://huggingface.co/${model.repo}/resolve/${model.revision}/README.md`, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Model card download returned ${response.status}.`);
    await writeFile(cardPath, await response.text());
  }
  await writeFile(join(root, 'model-prepared.json'), JSON.stringify(model, null, 2));
  console.log('The verified Nemotron 3.5 ASR model is bundled and ready for offline use.');
}
await prepareRuntime();
await prepareModel();
