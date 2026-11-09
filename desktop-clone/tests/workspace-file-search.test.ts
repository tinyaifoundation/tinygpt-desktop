import { expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectFiles } from '../src/main/files';
import { searchWorkspaceFiles } from '../src/main/workspace-file-search';

it('searches nested filenames while excluding protected paths and generated dependencies',async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'tinygpt-quick-open-')));
  for(const folder of ['src','.git','node_modules','dist']){await mkdir(join(root,folder));await writeFile(join(root,folder,'target.ts'),'source');}
  await writeFile(join(root,'.env'),'secret');await writeFile(join(root,'src','target.test.ts'),'test');
  const files=new ProjectFiles({} as never);const result=await searchWorkspaceFiles(files,root,'src target');expect(result.entries.map(file=>file.path)).toEqual(['src/target.test.ts','src/target.ts']);
  expect((await searchWorkspaceFiles(files,root,'')).entries.map(file=>file.path)).not.toContain('.env');await expect(searchWorkspaceFiles(files,null,'')).rejects.toThrow('Project');
});
