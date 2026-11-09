const {mkdir,writeFile,readFile,mkdtemp}=require('node:fs/promises');
const {resolve,join}=require('node:path');
const {spawnSync}=require('node:child_process');
const {build}=require('esbuild');
const yaml=require('js-yaml');
(async()=>{
  const staging=resolve('artifacts/work-runtime-package-app');await mkdir(staging,{recursive:true});
  await build({entryPoints:['scripts/work-runtimes-package-main.ts'],outfile:join(staging,'main.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron']});
  // A local marker keeps electron-builder from falling back to collecting the
  // parent desktop application's unrelated dependency tree for an empty app.
  const marker=join(staging,'node_modules/tinygpt-runtime-proof-marker');await mkdir(marker,{recursive:true});
  await writeFile(join(marker,'package.json'),JSON.stringify({name:'tinygpt-runtime-proof-marker',version:'1.0.0',main:'index.js'}));await writeFile(join(marker,'index.js'),'module.exports=true;');
  await writeFile(join(staging,'package.json'),JSON.stringify({name:'tinygpt-work-runtime-proof',version:'0.1.0',main:'main.cjs',description:'Isolated bundled command runtime packaging verification',dependencies:{'tinygpt-runtime-proof-marker':'1.0.0'}}));
  const source=yaml.load(await readFile('electron-builder.yml','utf8'));
  const resources=source.extraResources.filter(resource=>resource.to==='work-runtimes').map(resource=>({...resource,from:resolve(resource.from)}));
  const platform=process.platform,target=platform==='darwin'?'mac':'win',output=resolve('release/work-runtime-proof');
  const config={appId:'com.tinygpt.workruntimeproof',productName:'TinyGPT Runtime Proof',electronVersion:require('electron/package.json').version,electronDist:resolve('node_modules/electron/dist'),directories:{app:staging,output},files:['main.cjs','package.json'],asar:true,npmRebuild:false,extraResources:resources,afterPack:resolve(source.afterPack),win:{signAndEditExecutable:false},mac:{identity:null,minimumSystemVersion:source.mac.minimumSystemVersion,binaries:source.mac.binaries.filter(file=>file.includes('/work-runtimes/')),signIgnore:source.mac.signIgnore}};
  const configFile=resolve('artifacts/work-runtime-proof-builder.cjs');await writeFile(configFile,'module.exports='+JSON.stringify(config)+';\n');
  const packaged=spawnSync(process.execPath,[resolve('node_modules/electron-builder/cli.js'),'--'+target,'--dir','--config',configFile],{stdio:'inherit',windowsHide:true,timeout:180000});
  if(packaged.error)throw packaged.error;if(packaged.status!==0)throw Error('Runtime proof packaging failed.');
  const exe=platform==='darwin'?join(output,'mac-arm64','TinyGPT Runtime Proof.app/Contents/MacOS/TinyGPT Runtime Proof'):join(output,'win-unpacked','TinyGPT Runtime Proof.exe');
  await mkdir('.tools-smoke-profile',{recursive:true});const profile=await mkdtemp(resolve('.tools-smoke-profile/packaged-runtime-')),system=process.env.SystemRoot||'C:\\Windows';
  const env={PATH:platform==='win32'?join(system,'System32'):'/usr/bin:/bin',SystemRoot:system,WINDIR:system,PATHEXT:'.COM;.EXE;.BAT;.CMD',TEMP:profile,TMP:profile,HOME:profile,USERPROFILE:profile,APPDATA:join(profile,'config'),LOCALAPPDATA:join(profile,'local'),TINYGPT_RUNTIME_TEST_PROFILE:profile};
  const proof=spawnSync(exe,[],{env,stdio:'inherit',windowsHide:true,timeout:120000});if(proof.error)throw proof.error;if(proof.status!==0)throw Error('Packaged runtime execution failed.');
  const result=JSON.parse(await readFile(join(profile,'proof.json'),'utf8'));if(!result.packaged||!result.passed)throw Error('Packaged runtime proof missing.');
  await writeFile('artifacts/work-runtimes-packaged-proof.json',JSON.stringify(result,null,2)+'\n');console.log('Packaged runtime proof: '+profile);
})().catch(error=>{console.error(error);process.exitCode=1;});
