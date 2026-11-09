import { readFile, mkdir, writeFile, rename, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const manifest = JSON.parse(await readFile(new URL('../src/shared/rag-models.json', import.meta.url), 'utf8'));
const root = fileURLToPath(new URL('../runtimes/rag/', import.meta.url));
for (const [name, model] of Object.entries(manifest)) {
  for (const file of model.files) {
    const path = join(root, name, file.path);
    async function valid(path) {
      try {
        if ((await stat(path)).size !== file.size) return false;
        const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk);
        return hash.digest('hex') === file.sha256;
      } catch { return false; }
    }
    if (await valid(path)) continue;
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.part`;
    try {
      const response = await fetch(`https://huggingface.co/${model.repository}/resolve/${model.revision}/${file.path}`, { signal: AbortSignal.timeout(180000) });
      if (!response.ok) throw new Error(`Could not prepare ${name}: ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`Checksum mismatch: ${name}/${file.path}`);
      await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }
  console.log(`Bundled ${name} verified (${model.files.reduce((sum, file) => sum + file.size, 0).toLocaleString()} bytes).`);
}
await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
