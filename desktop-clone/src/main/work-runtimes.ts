import {app} from 'electron';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import pins from '../shared/work-runtimes.json';

export const WORK_RUNTIMES_ERROR='The bundled Python and Node tools are unavailable. Reinstall TinyGPT or prepare its development runtimes.';
export function workRuntimePaths(root=app?.isPackaged?join(process.resourcesPath,'work-runtimes'):join(__dirname,'../../runtimes/work-runtimes')){
  const windows=process.platform==='win32';
  return {root,node:join(root,'node',windows?'node.exe':'bin/node'),python:join(root,'python',windows?'python.exe':'bin/python'+pins.python.version.split('.').slice(0,2).join('.')),nodeBin:join(root,'node',windows?'':'bin'),pythonBin:join(root,'python',windows?'':'bin'),npm:join(root,'node',windows?'node_modules/npm/bin/npm-cli.js':'lib/node_modules/npm/bin/npm-cli.js'),npx:join(root,'node',windows?'node_modules/npm/bin/npx-cli.js':'lib/node_modules/npm/bin/npx-cli.js')};
}
const checked=new Map<string,Promise<ReturnType<typeof workRuntimePaths>>>();
export async function workRuntimes(root?:string){
  const paths=workRuntimePaths(root);
  if(!checked.has(paths.root))checked.set(paths.root,(async()=>{
    try{
      const manifest=JSON.parse(await readFile(join(paths.root,'prepared.json'),'utf8'));
      const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
      if(manifest.format!==2||manifest.target!==`${process.platform}-${process.arch}`||manifest.pins!==hash(JSON.stringify(pins)))throw Error();
      const lib=join(paths.root,'python',process.platform==='win32'?'Lib':'lib/python'+pins.python.version.split('.').slice(0,2).join('.'));
      const files=[paths.node,paths.python,paths.npm,paths.npx,join(lib,'encodings/__init__.py'),join(lib,'venv/__init__.py'),join(lib,'ensurepip/__init__.py'),join(lib,'site-packages/pip/__init__.py')];
      if(process.platform==='win32')files.push(join(paths.pythonBin,'python3.exe'),join(paths.pythonBin,'python'+pins.python.version.split('.').slice(0,2).join('')+'.dll'));
      for(const file of files){
        const relative=file.slice(paths.root.length+1).replaceAll('\\','/');
        const entry=manifest.files.find((entry:{path:string;sha256?:string})=>entry.path===relative);
        const bytes=await readFile(file);
        // The release hook verifies every file before signing. Apple signing
        // changes Mach-O executables; their signed bytes differ from the archive.
        const signedNative=app?.isPackaged&&process.platform==='darwin'&&(file===paths.node||file===paths.python);
        if(!entry?.sha256||!bytes.length||(!signedNative&&hash(bytes)!==entry.sha256))throw Error();
      }
      return paths;
    }catch{throw Error(WORK_RUNTIMES_ERROR);}
  })().catch(error=>{checked.delete(paths.root);throw error;}));
  return checked.get(paths.root)!;
}
export function workCommand(executable:string,args:string[],runtime:ReturnType<typeof workRuntimePaths>){
  const name=executable.replace(/\.(exe|cmd)$/i,'').toLowerCase();
  if(name==='node')return {executable:runtime.node,args};
  if(name==='python'||name==='python3')return {executable:runtime.python,args};
  if(name==='npm'||name==='npx')return {executable:runtime.node,args:[runtime[name],...args]};
  return {executable,args};
}

export function workRuntimeState(directory:string){return join(app?.getPath?.('userData')??tmpdir(),'work-command-runtime',createHash('sha256').update(directory).digest('hex').slice(0,24));}
