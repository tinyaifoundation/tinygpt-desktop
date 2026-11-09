import { ProjectFiles, scopedPath } from './files';
import type { WorkspaceEntry } from '../shared/workspace';

/** Bounded filename search, using the same canonical/protected-path rules as
 * the explorer. Generated/dependency directories do not fill Quick Open. */
export async function searchWorkspaceFiles(files:ProjectFiles,root:string|null,query:string){
  await scopedPath(root,'.');
  const pending=['.'];const entries:WorkspaceEntry[]=[];let visited=0,truncated=false;const deadline=Date.now()+3000;
  const words=query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  while(pending.length&&visited<10000&&entries.length<200&&Date.now()<deadline){
    const path=pending.shift()!;let result:Awaited<ReturnType<ProjectFiles['list']>>;
    try{result=await files.list(root,path,new AbortController().signal);}catch{continue;}
    truncated ||= result.truncated;
    for(const item of result.entries){visited++;const relative=path==='.'?item.name:`${path}/${item.name}`;
      if(item.directory){if(!['dist','out','build','.next','.cache','coverage','vendor'].includes(item.name.toLowerCase()))pending.push(relative);}
      else if(words.every(word=>relative.toLowerCase().includes(word))){entries.push({name:item.name,path:relative,kind:'file',size:null});if(entries.length===200)break;}
    }
  }
  return{entries:entries.sort((a,b)=>a.path.localeCompare(b.path)),truncated:truncated||pending.length>0||visited>=10000};
}
