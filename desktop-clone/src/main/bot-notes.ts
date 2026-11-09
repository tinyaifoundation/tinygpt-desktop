import { readFile, writeFile, rename, realpath, lstat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { botNoteFileSchema, botNoteSchema, type BotNote } from '../shared/bot';

async function checkedFile(workspace: string, file: string) {
  const root = await realpath(workspace); if (resolve(root).toLowerCase() !== resolve(workspace).toLowerCase()) throw Error('The Bot workspace has moved. Restore its original location to edit its notes.');
  const path = join(root, botNoteFileSchema.parse(file));
  try { if ((await lstat(path)).isSymbolicLink()) throw Error('Linked Bot notes cannot be edited here.'); const actual = await realpath(path), inside = relative(root, actual); if (inside.startsWith('..') || isAbsolute(inside)) throw Error('The Bot note is outside its workspace.'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return path;
}
export async function botNotes(workspace: string): Promise<BotNote[]> {
  return Promise.all(botNoteFileSchema.options.map(async file => {
    const path = await checkedFile(workspace, file); let text = '';
    try { text = await readFile(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return { file, text: text.slice(0, 32000), editable: text.length <= 32000 };
  }));
}
export async function saveBotNote(workspace: string, value: { file: BotNote['file']; text: string }) {
  const note = botNoteSchema.parse(value), path = await checkedFile(workspace, note.file);
  const temporary = join(workspace, `note-${randomUUID()}.tmp`); await writeFile(temporary, note.text, { mode: 0o600, flag: 'wx' }); await rename(temporary, path);
  return botNotes(workspace);
}
