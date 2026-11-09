import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,readdir,readlink,copyFile,rename,rm,lstat} from 'node:fs/promises';
import {join,resolve,sep,basename} from 'node:path';
import {execFileSync} from 'node:child_process';

const pins=JSON.parse(await readFile(new URL('../src/shared/work-runtimes.json',import.meta.url),'utf8'));
const target=process.argv.find(arg=>arg.startsWith('--target='))?.slice(9)??`${process.platform}-${process.arch}`;
const root=resolve(target===`${process.platform}-${process.arch}`?'runtimes/work-runtimes':`runtimes/work-runtimes-${target}`);
const cache=resolve('runtimes/.work-runtime-cache');const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const pinHash=hash(JSON.stringify(pins));await mkdir(root,{recursive:true});await mkdir(cache,{recursive:true});
const within=(path)=>{const value=resolve(path);if(!value.startsWith(root+sep))throw Error('Unexpected runtime preparation path.');return value;};
try {
  const saved=JSON.parse(await readFile(join(root,'prepared.json'),'utf8'));
  if(saved.format===2&&saved.target===target&&saved.pins===pinHash&&(await Promise.all(saved.files.map(async file=>file.link?await readlink(within(join(root,file.path)))===file.link:hash(await readFile(within(join(root,file.path))))===file.sha256))).every(Boolean)){
    console.log(`Bundled Work runtimes verified (${target}): Python ${pins.python.version}, Node ${pins.node.version}, npm/npx ${pins.node.npm}.`);process.exit(0);
  }
}catch{}
for(const name of ['node','python']){
  const asset=pins[name].targets[target];if(!asset)throw Error(`No pinned ${name} distribution for ${target}.`);
  const archive=join(cache,basename(new URL(asset.url).pathname));let bytes;
  try{bytes=await readFile(archive);}catch{}
  if(!bytes||hash(bytes)!==asset.sha256){console.log(`Downloading pinned ${name} ${pins[name].version} (${target})…`);const response=await fetch(asset.url,{signal:AbortSignal.timeout(120000)});if(!response.ok)throw Error(`${name} download returned HTTP ${response.status}.`);bytes=Buffer.from(await response.arrayBuffer());if(hash(bytes)!==asset.sha256)throw Error(`${name} checksum mismatch.`);await writeFile(archive,bytes);}
  const stage=within(join(root,`stage-${name}`));await rm(stage,{recursive:true,force:true});await mkdir(stage,{recursive:true});
  try{
    if(archive.endsWith('.zip')){const quote=value=>`'${value.replaceAll("'","''")}'`;const windowsRoot=process.env.SystemRoot||'C:/Windows';const modulePath=[join(windowsRoot,'System32/WindowsPowerShell/v1.0/Modules'),join(process.env.ProgramFiles||'C:/Program Files','WindowsPowerShell/Modules')].join(';');execFileSync(join(windowsRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',`Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(stage)}`],{windowsHide:true,env:{...process.env,PSModulePath:modulePath}});}
    else execFileSync('tar',['-xzf',archive,'-C',stage],{windowsHide:true});
    const source=within(join(stage,asset.directory)),destination=within(join(root,name));await lstat(source);await rm(destination,{recursive:true,force:true});await rename(source,destination);
  }finally{await rm(within(stage),{recursive:true,force:true});}
}
if(target==='win32-x64'){
  await copyFile(join(root,'python/python.exe'),join(root,'python/python3.exe'));
  // PowerShell chooses .ps1 over .cmd. Keep the official .cmd launchers so npm
  // works under Windows' default Restricted execution policy as well.
  for(const name of ['npm.ps1','npx.ps1'])await rm(within(join(root,'node',name)),{force:true});
}
const files=[];
async function collect(directory){for(const entry of await readdir(directory,{withFileTypes:true})){const path=join(directory,entry.name),relative=path.slice(root.length+1).replaceAll('\\','/');if(entry.isSymbolicLink())files.push({path:relative,link:await readlink(path)});else if(entry.isDirectory())await collect(path);else files.push({path:relative,sha256:hash(await readFile(path))});}}
await collect(join(root,'node'));await collect(join(root,'python'));
await writeFile(join(root,'prepared.json'),JSON.stringify({format:2,target,pins:pinHash,node:pins.node.version,python:pins.python.version,npm:pins.node.npm,files},null,2)+'\n');
console.log(`Prepared bundled Work runtimes (${target}), ${files.length} verified files.`);
