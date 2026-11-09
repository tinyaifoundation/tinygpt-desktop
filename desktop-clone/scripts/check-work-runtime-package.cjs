const {readFile,readlink}=require('node:fs/promises');
const {resolve,join,sep}=require('node:path');
const {createHash}=require('node:crypto');
const pins=require('../src/shared/work-runtimes.json');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

/** Run after resources are copied, before Apple signing changes native bytes. */
async function verifyWorkRuntimePackage(root,target){
  root=resolve(root);
  const manifest=JSON.parse(await readFile(join(root,'prepared.json'),'utf8'));
  if(manifest.format!==2||manifest.target!==target||manifest.pins!==hash(JSON.stringify(pins)))throw Error('Wrong or stale bundled Work runtimes for '+target);
  if(!pins.node.targets[target]||!pins.python.targets[target]||!manifest.files?.length)throw Error('Unsupported bundled runtime target: '+target);
  for(const entry of manifest.files){
    const path=resolve(root,entry.path);
    if(!path.startsWith(root+sep))throw Error('Invalid runtime manifest path.');
    if(entry.link){
      const link=await readlink(path),resolved=resolve(path,'..',link);
      if(!resolved.startsWith(root+sep)||link!==entry.link)throw Error('Invalid runtime symbolic link: '+entry.path);
    }else if(hash(await readFile(path))!==entry.sha256)throw Error('Bundled runtime checksum mismatch: '+entry.path);
  }
  // Verify that packaging retained the entry points, aliases, package CLIs and
  // Python modules instead of merely copying a manifest or one executable.
  const names=new Set(manifest.files.map(file=>file.path));
  const required=target.startsWith('win32-')?['node/node.exe','node/npm.cmd','node/npx.cmd','node/node_modules/npm/bin/npm-cli.js','node/node_modules/npm/bin/npx-cli.js','python/python.exe','python/python3.exe','python/python313.dll','python/Lib/venv/__init__.py','python/Lib/ensurepip/__init__.py','python/Lib/site-packages/pip/__init__.py']:['node/bin/node','node/bin/npm','node/bin/npx','node/lib/node_modules/npm/bin/npm-cli.js','node/lib/node_modules/npm/bin/npx-cli.js','python/bin/python','python/bin/python3','python/bin/python3.13','python/lib/libpython3.13.dylib','python/lib/python3.13/venv/__init__.py','python/lib/python3.13/ensurepip/__init__.py','python/lib/python3.13/site-packages/pip/__init__.py'];
  for(const file of required)if(!names.has(file))throw Error('Missing packaged runtime entry point: '+file);
  console.log('Packaged Python, Node, npm and npx verified: '+target+' ('+manifest.files.length+' files).');
}
module.exports=async context=>{
  const platform=context.electronPlatformName;
  const arch=require('builder-util').Arch[context.arch];
  const resources=platform==='darwin'?join(context.appOutDir,context.packager.appInfo.productFilename+'.app','Contents','Resources'):join(context.appOutDir,'resources');
  await verifyWorkRuntimePackage(join(resources,'work-runtimes'),platform+'-'+arch);
};
module.exports.verifyWorkRuntimePackage=verifyWorkRuntimePackage;
if(require.main===module)verifyWorkRuntimePackage(process.argv[2]||'runtimes/work-runtimes',process.argv[3]||process.platform+'-'+process.arch).catch(error=>{console.error(error);process.exitCode=1;});
