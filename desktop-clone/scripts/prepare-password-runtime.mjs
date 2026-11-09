import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve('runtimes/passwords'); mkdirSync(root,{recursive:true});
function run(command,args,options={}) { const result=spawnSync(command,args,{stdio:'inherit',windowsHide:true,...options}); if(result.error)throw result.error;if(result.status!==0)throw Error('Native password service build failed.'); }
let output;
if(process.platform==='win32') {
  if(process.arch!=='x64')throw Error('The Windows password service currently requires x64.');
  const vswhere=join(process.env['ProgramFiles(x86)']||'C:/Program Files (x86)','Microsoft Visual Studio/Installer/vswhere.exe');
  const found=spawnSync(vswhere,['-latest','-products','*','-requires','Microsoft.VisualStudio.Component.VC.Tools.x86.x64','-property','installationPath'],{encoding:'utf8',windowsHide:true});
  const vcvars=join(found.stdout?.trim()||'', 'VC/Auxiliary/Build/vcvars64.bat'); if(!existsSync(vcvars))throw Error('Install the Visual Studio C++ build tools to build native password protection.');
  output=join(root,'tinygpt-passwords.dll');
  writeFileSync(join(root,'build.cmd'),`@echo off\r\ncall "${vcvars}" >nul\r\nif errorlevel 1 exit /b 1\r\ncl /nologo /std:c++20 /EHsc /O2 /MT /LD "${resolve('native/passwords/windows.cpp')}" /Fo"${join(root,'windows.obj')}" /link /OUT:"${output}" /IMPLIB:"${join(root,'tinygpt-passwords.lib')}" advapi32.lib user32.lib windowsapp.lib\r\n`);
  run('cmd.exe',['/d','/c','runtimes\\passwords\\build.cmd']);
} else if(process.platform==='darwin') {
  output=join(root,'libtinygpt-passwords.dylib');
  run('xcrun',['clang++','-std=c++17','-fobjc-arc','-O2','-dynamiclib','-fvisibility=hidden','-arch',process.arch==='arm64'?'arm64':'x86_64','native/passwords/macos.mm','-framework','Foundation','-framework','Security','-framework','LocalAuthentication','-o',output]);
} else throw Error('Saved browser passwords are supported on Windows and macOS only.');
writeFileSync(join(root,'prepared.json'),JSON.stringify({version:1,target:`${process.platform}-${process.arch}`,file:output.split(/[\\/]/).pop(),sha256:createHash('sha256').update(readFileSync(output)).digest('hex')},null,2)+'\n');
console.log('Native password service prepared.');
