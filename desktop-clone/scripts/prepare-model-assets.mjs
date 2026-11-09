import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, relative } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const mappings = [['voice-runtime', 'runtimes/voice'], ['rag', 'runtimes/rag'], ['vision', 'runtimes/vision']];
const files = [], uploads = [];
for (const [group, folder] of mappings) {
  const source = join(root, folder);
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name), name = relative(source, path).replaceAll('\\', '/');
      if (entry.isSymbolicLink()) throw Error('Unexpected model asset link.');
      if (name.startsWith('kokoro/') || /^pocket-tts\/cloning\./.test(name)) continue;
      if (entry.isDirectory()) await walk(path);
      else if (/\.(?:gguf|onnx|ort|safetensors|bin)$/i.test(entry.name)) {
        const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk);
        const sha256 = hash.digest('hex'), bytes = (await stat(path)).size;
        files.push({ path: `${group}/${name}`, sha256, bytes });
        uploads.push({ source: path, key: `assets/sha256/${sha256}`, sha256, bytes });
      }
    }
  }
  await walk(source);
}
if (!files.some(file => file.path.endsWith('MiniCPM5-2B-Q4_K_M.gguf')) || !files.some(file => file.path.endsWith('model_quantized.onnx'))) throw Error('Prepare all included model runtimes before creating the catalog.');
files.sort((a, b) => a.path.localeCompare(b.path));
await mkdir(join(root, 'build'), { recursive: true }); await mkdir(join(root, '.tmp'), { recursive: true });
await writeFile(join(root, 'build/model-assets.json'), JSON.stringify({ version: 1, files }, null, 2));
await writeFile(join(root, '.tmp/model-asset-uploads.json'), JSON.stringify(uploads, null, 2));
console.log(`Prepared ${files.length} independently versioned model files (${(files.reduce((sum, file) => sum + file.bytes, 0) / 1e9).toFixed(2)} GB).`);
