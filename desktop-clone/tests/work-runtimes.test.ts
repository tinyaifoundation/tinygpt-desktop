import {afterAll,it,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,cp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {spawn} from 'node:child_process';
import JSZip from 'jszip';
import {codeShellEnvironment} from '../src/main/code-shell';
import {WORK_RUNTIMES_ERROR,workRuntimePaths,workRuntimes} from '../src/main/work-runtimes';
import pins from '../src/shared/work-runtimes.json';

const directories:string[]=[];
afterAll(async()=>{for(const path of directories){if(!resolve(path).startsWith(resolve(tmpdir())+sep)||!path.includes('tinygpt-runtime-proof-'))throw Error('Unexpected fixture path');await rm(path,{recursive:true,force:true});}});
function run(command:string,args:string[],cwd:string,env:NodeJS.ProcessEnv){return new Promise<string>((resolve,reject)=>{const child=spawn(command,args,{cwd,env,windowsHide:true});let output='';child.stdout.on('data',part=>output+=part);child.stderr.on('data',part=>output+=part);child.on('error',reject);child.on('close',code=>code===0?resolve(output.trim()):reject(Error(output||'Exit '+code)));});}
it('runs relocated Python, Node, npm and npx with no system developer tools or network packages',async()=>{
  const root=await mkdtemp(join(tmpdir(),'tinygpt-runtime-proof-'));directories.push(root);
  const resources=join(root,'resources with spaces','work-runtimes');await cp(workRuntimePaths().root,resources,{recursive:true});
  const runtime=await workRuntimes(resources);
  const cwd=join(root,'project with spaces');await mkdir(cwd,{recursive:true});
  const system=process.env.SystemRoot??'C:\\Windows';
  const base:NodeJS.ProcessEnv={PATH:process.platform==='win32'?join(system,'System32'):'/usr/bin:/bin',SystemRoot:system,WINDIR:system,TEMP:root,TMP:root,HOME:root,USERPROFILE:root,APPDATA:join(root,'config'),LOCALAPPDATA:join(root,'local'),PATHEXT:'.COM;.EXE;.BAT;.CMD'};
  const env={...base,...await codeShellEnvironment(join(root,'state'),base,resources),NPM_CONFIG_OFFLINE:'true',npm_config_offline:'true',NPM_CONFIG_REGISTRY:'http://127.0.0.1:9',npm_config_registry:'http://127.0.0.1:9',NPM_CONFIG_UPDATE_NOTIFIER:'false',npm_config_update_notifier:'false'};
  const node=JSON.parse(await run('node',['-e','console.log(JSON.stringify({version:process.versions.node,path:process.execPath,electron:process.versions.electron??null}))'],cwd,env));
  expect(node.version).toBe(pins.node.version);expect(node.path).toBe(runtime.node);expect(node.electron).toBeNull();
  for(const name of ['python','python3'])expect(await run(name,['-c','import sys, ssl, sqlite3, venv, pip; print(sys.version.split()[0]); print(sys.executable)'],cwd,env)).toContain(pins.python.version);
  await run('python',['-m','venv','--copies','.venv'],cwd,env);
  const python=join(cwd,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const zip=new JSZip(),dist='tinygpt_runtime_fixture-1.0.dist-info';zip.file('tinygpt_runtime_fixture/__init__.py','value = 42\n');zip.file(dist+'/METADATA','Metadata-Version: 2.1\nName: tinygpt-runtime-fixture\nVersion: 1.0\n');zip.file(dist+'/WHEEL','Wheel-Version: 1.0\nGenerator: TinyGPT fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n');zip.file(dist+'/RECORD','');
  const wheel=join(cwd,'tinygpt_runtime_fixture-1.0-py3-none-any.whl');await writeFile(wheel,await zip.generateAsync({type:'nodebuffer'}));
  await run(python,['-m','pip','install','--no-index','--no-deps',wheel],cwd,env);
  expect(await run(python,['-c','import tinygpt_runtime_fixture; print(tinygpt_runtime_fixture.value)'],cwd,env)).toBe('42');
  expect(await run('python',['-c',"import importlib.util; print(importlib.util.find_spec('tinygpt_runtime_fixture'))"],cwd,env)).toBe('None');
  await mkdir(join(cwd,'fixture-cli'));await writeFile(join(cwd,'fixture-cli','package.json'),JSON.stringify({name:'tinygpt-fixture-cli',version:'1.0.0',bin:{'tinygpt-fixture-cli':'index.js'}}));await writeFile(join(cwd,'fixture-cli','index.js'),'#!/usr/bin/env node\nconsole.log(JSON.stringify({args:process.argv.slice(2),node:process.execPath}));');
  await writeFile(join(cwd,'package.json'),JSON.stringify({name:'offline-proof',version:'1.0.0',scripts:{proof:'node -e "console.log(42)"'},devDependencies:{'tinygpt-fixture-cli':'file:./fixture-cli'}}));
  const shell=process.platform==='win32'?join(system,'System32/WindowsPowerShell/v1.0/powershell.exe'):'/bin/sh';
  const shellRun=(command:string)=>run(shell,process.platform==='win32'?['-NoProfile','-NonInteractive','-ExecutionPolicy','Restricted','-Command',command]:['-c',command],cwd,env);
  expect(await shellRun('npm --version')).toBe(pins.node.npm);expect(await shellRun('npx --version')).toBe(pins.node.npm);
  await shellRun('npm install --offline --ignore-scripts --no-audit --no-fund');expect(await shellRun('npm run --silent proof')).toBe('42');
  const result=JSON.parse(await shellRun('npx --offline --no-install tinygpt-fixture-cli "argument with spaces"'));
  expect(result).toEqual({args:['argument with spaces'],node:runtime.node});
  const checker=resolve('scripts/check-work-runtime-package.cjs');
  expect(await run(runtime.node,[checker,resources],cwd,env)).toContain('Packaged Python, Node, npm and npx verified');
  await writeFile(runtime.npx,'// corrupted package CLI');
  await expect(run(runtime.node,[checker,resources],cwd,env)).rejects.toThrow('Bundled runtime checksum mismatch');
},120000);

it('fails clearly for missing or corrupted bundled tools instead of selecting host installations',async()=>{
  const root=await mkdtemp(join(tmpdir(),'tinygpt-runtime-proof-'));directories.push(root);
  await expect(workRuntimes(root)).rejects.toThrow(WORK_RUNTIMES_ERROR);
  await cp(workRuntimePaths().root,root,{recursive:true});
  const paths=workRuntimePaths(root),manifest=JSON.parse(await readFile(join(root,'prepared.json'),'utf8'));
  manifest.files.find((file:{path:string})=>file.path===paths.node.slice(root.length+1).replaceAll('\\','/')).sha256='0'.repeat(64);
  await writeFile(join(root,'prepared.json'),JSON.stringify(manifest));
  await expect(workRuntimes(root)).rejects.toThrow(WORK_RUNTIMES_ERROR);
},120000);
