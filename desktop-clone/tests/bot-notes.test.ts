import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { botNotes, saveBotNote } from '../src/main/bot-notes';
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) { const target = resolve(directory); if (dirname(target).toLowerCase() !== resolve(tmpdir()).toLowerCase() || !basename(target).startsWith('tinygpt-bot-notes-')) throw Error('Unexpected test directory.'); await rm(target, { recursive: true, force: true }); } });
async function workspace() { const directory = await mkdtemp(join(tmpdir(), 'tinygpt-bot-notes-')); directories.push(directory); return directory; }
it('limits editing to native personalization files and preserves oversized notes', async () => {
  const directory = await workspace(); await writeFile(join(directory, 'AGENTS.md'), 'A'.repeat(32001));
  expect((await botNotes(directory)).find(note => note.file === 'AGENTS.md')).toMatchObject({ editable: false, text: 'A'.repeat(32000) });
  await expect(saveBotNote(directory, { file: '../outside.md' as any, text: 'overwrite' })).rejects.toThrow();
  await expect(saveBotNote(directory, { file: 'USER.md', text: 'B'.repeat(32001) })).rejects.toThrow();
  await saveBotNote(directory, { file: 'SOUL.md', text: 'A calm personality.' });
  expect(await readFile(join(directory, 'SOUL.md'), 'utf8')).toBe('A calm personality.');
  expect((await readFile(join(directory, 'AGENTS.md'), 'utf8')).length).toBe(32001);
});
it('refuses redirected workspaces before writing notes', async () => {
  const directory = await workspace(), linked = join(directory, 'linked');
  await symlink(directory, linked, 'junction');
  await expect(saveBotNote(linked, { file: 'SOUL.md', text: 'overwrite' })).rejects.toThrow('workspace has moved');
});
