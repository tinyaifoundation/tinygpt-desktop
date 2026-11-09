import {mkdir,writeFile} from 'node:fs/promises';
import {join,delimiter} from 'node:path';
import {workRuntimes,workRuntimePaths} from './work-runtimes';

/** Invoke the real bundled executable directly, preserving inline JS arguments. */
export function bundledNodePowerShell(executable=workRuntimePaths().node){
  const quoted="'"+executable.replaceAll("'","''")+"'";
  return 'function node { & '+quoted+' @args | Out-Default; $global:LASTEXITCODE = $LASTEXITCODE; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } };';
}
/** One private runtime environment for Work, delegated coding and user PTYs. */
export async function codeShellEnvironment(root:string,environment:NodeJS.ProcessEnv=process.env,runtimeRoot?:string):Promise<Record<string,string>>{
  const runtime=await workRuntimes(runtimeRoot);
  const config=join(root,'project.npmrc'),cache=join(root,'project-npm-cache'),prefix=join(root,'project-npm-global'),pipCache=join(root,'project-pip-cache');
  await mkdir(root,{recursive:true});await writeFile(config,'',{mode:0o600});await Promise.all([cache,prefix,pipCache].map(path=>mkdir(path,{recursive:true})));
  return {PATH:[runtime.nodeBin,runtime.pythonBin,process.platform==='win32'?prefix:join(prefix,'bin'),environment.PATH??environment.Path??''].filter(Boolean).join(delimiter),
    ELECTRON_RUN_AS_NODE:'',NODE_OPTIONS:'',NODE_PATH:'',PYTHONHOME:'',PYTHONPATH:'',PYTHONUSERBASE:'',PYTHONSTARTUP:'',PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1',
    PIP_CONFIG_FILE:process.platform==='win32'?'NUL':'/dev/null',PIP_CACHE_DIR:pipCache,PIP_DISABLE_PIP_VERSION_CHECK:'1',PIP_USER:'false',PIP_REQUIRE_VIRTUALENV:'true',
    NPM_CONFIG_USERCONFIG:config,npm_config_userconfig:config,NPM_CONFIG_OFFLINE:'false',npm_config_offline:'false',
    NPM_CONFIG_REGISTRY:'https://registry.npmjs.org/',npm_config_registry:'https://registry.npmjs.org/',
    NPM_CONFIG_CACHE:cache,npm_config_cache:cache,NPM_CONFIG_PREFIX:prefix,npm_config_prefix:prefix};
}
