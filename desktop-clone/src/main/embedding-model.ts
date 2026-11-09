import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import manifest from '../shared/rag-models.json';

/** Worker-only validation. The installer includes every file; never fetch here. */
export async function verifyRagModel(root: string, name: keyof typeof manifest): Promise<string> {
  const path = join(root, name);
  for (const file of manifest[name].files) {
    const full = join(path, file.path);
    if ((await stat(full)).size !== file.size) throw new Error('Bundled retrieval model is damaged.');
    const hash = createHash('sha256'); for await (const bytes of createReadStream(full)) hash.update(bytes);
    if (hash.digest('hex') !== file.sha256) throw new Error('Bundled retrieval model checksum mismatch.');
  }
  return path;
}
