import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { dictationModel as model } from '../shared/dictation';

/** Build preparation verifies the weights. Runtime only checks the bundled
 * resource's metadata and size: no download, model hash, or inference on main. */
export async function bundledDictationModel(root: string): Promise<string> {
  const path = join(root, 'models', model.file);
  const prepared = JSON.parse(await readFile(join(root, 'model-prepared.json'), 'utf8').catch(() => { throw new Error('The bundled dictation model is missing. Reinstall TinyGPT.'); }));
  if (prepared.sha256 !== model.sha256 || prepared.revision !== model.revision || (await stat(path)).size !== model.size) throw new Error('The bundled dictation model is incomplete. Reinstall TinyGPT.');
  return path;
}
