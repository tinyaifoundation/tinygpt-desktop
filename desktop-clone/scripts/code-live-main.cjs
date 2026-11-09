// Used only by the explicitly requested live smoke. No plaintext credential file.
const {app}=require('electron');
const {readFileSync,writeFileSync,mkdirSync}=require('node:fs');
const {resolve,join}=require('node:path');
const profile=resolve(process.env.TINYGPT_TOOLS_PROFILE);const normal=join(process.env.APPDATA,'tinygpt-desktop');mkdirSync(profile,{recursive:true});
const settings=JSON.parse(readFileSync(join(normal,'settings.json'),'utf8'));
if(settings.byok.provider!=='openrouter'||!/^https:\/\/openrouter\.ai\/api\/v1\/?$/.test(settings.byok.endpoint))throw new Error('Expected configured OpenRouter route.');
const vault=JSON.parse(readFileSync(join(normal,'credentials.json'),'utf8'));const state=JSON.parse(readFileSync(join(normal,'Local State'),'utf8'));
writeFileSync(join(profile,'settings.json'),JSON.stringify({...settings,mode:'code',route:'byok',byok:{...settings.byok,contextWindowTokens:64000,maxOutputTokens:4096},toolPermissions:{...settings.toolPermissions,read:'allow',write:'ask',execute:'ask'}}));
writeFileSync(join(profile,'credentials.json'),JSON.stringify({byok:vault.byok}),{mode:0o600});writeFileSync(join(profile,'Local State'),JSON.stringify({os_crypt:state.os_crypt}),{mode:0o600});
app.setPath('userData',profile);app.on('browser-window-created',(_event,window)=>window.hide());require('../out/main/index.js');
