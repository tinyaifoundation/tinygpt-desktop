import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { codeShellEnvironment, bundledNodePowerShell } from '../src/main/code-shell';
import { codePlugin } from '../src/main/code-plugin';
import pins from '../src/shared/work-runtimes.json';
import { workRuntimePaths } from '../src/main/work-runtimes';
it('honours longer native command deadlines rather than clamping every command to two minutes',async()=>{
  const factory=new Function('fetch','process',codePlugin('http://localhost/native','fixture').replace('export default async','return async'))(async()=>({ok:true,json:async()=>({})}),{platform:'linux'});const hooks=await factory();
  const output={args:{command:'npm run build',timeout:600000}};await hooks['tool.execute.before']({tool:'bash',callID:'fixture'},output);expect(output.args.timeout).toBe(600000);
  output.args.timeout=NaN;await hooks['tool.execute.before']({tool:'bash',callID:'fixture2'},output);expect(output.args.timeout).toBe(120000);
});
it.skipIf(process.platform!=='win32')('preserves inline JavaScript operators and propagates a failing Node command',async()=>{
  const run=(script:string,after='')=>new Promise<{code:number|null;output:string}>(resolve=>{
    const child=spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-Command',bundledNodePowerShell(workRuntimePaths().node)+'\nnode -e "'+script+'"\n'+after],{windowsHide:true});let output='';child.stdout.on('data',part=>output+=part);child.stderr.on('data',part=>output+=part);child.on('close',code=>resolve({code,output}));
  });
  const good=await run('console.log([21].map(x=>x*2)[0])');expect(good.code).toBe(0);expect(good.output.trim()).toBe('42');
  for(const code of [1,7]) { const bad=await run(`process.exit(${code})`,"Write-Output 'SHOULD_NOT_RUN'");expect(bad.code).toBe(code);expect(bad.output).not.toContain('SHOULD_NOT_RUN'); }
  const restored=await run('console.log(42)',"if ($env:ELECTRON_RUN_AS_NODE) { Write-Output 'MODE_LEAKED' } else { Write-Output 'MODE_RESTORED' }");expect(restored.code).toBe(0);expect(restored.output).toContain('MODE_RESTORED');
});
it('uses packaged npm/npx even when a different installation is present on PATH',async()=>{
  const root=await mkdtemp(join(tmpdir(),'tinygpt shell space '));const installed=join(root,'installed old node');await mkdir(join(installed,'node_modules/npm/bin'),{recursive:true});
  for(const name of ['npm','npx'])await writeFile(join(installed,'node_modules/npm/bin/'+name+'-cli.js'),"throw Error('HOST_NPM_USED')");
  const env=await codeShellEnvironment(join(root,'runtime with spaces'),{PATH:installed});
  for(const name of ['npm','npx']){
    const output=await new Promise<string>((resolve,reject)=>{const child=process.platform==='win32'?spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-Command',name+' --version'],{env:{...process.env,...env},windowsHide:true}):spawn(name,['--version'],{env:{...process.env,...env}});let text='';child.stdout.on('data',part=>text+=part);child.stderr.on('data',part=>text+=part);child.on('error',reject);child.on('close',code=>code===0?resolve(text):reject(new Error(text)));});
    expect(output.trim()).toBe(pins.node.npm);
  }
});
