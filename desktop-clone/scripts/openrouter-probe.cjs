// Explicitly authorized, bounded live check. Credentials never leave Electron main
// except in the HTTPS Authorization header; output contains timings/counts only.
const { app, safeStorage } = require('electron');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const fs = require('node:fs/promises');
const { resolve, join } = require('node:path');
const normal = join(process.env.APPDATA, 'tinygpt-desktop');
const profile = resolve('.tools-smoke-profile', 'live-probe-' + Date.now()); mkdirSync(profile,{recursive:true});
// Windows safeStorage's OS-wrapped encryption key is profile-specific. Copy
// only that encrypted key container, not cookies, accounts or browser history.
try { const state = JSON.parse(readFileSync(join(normal,'Local State'),'utf8')); writeFileSync(join(profile,'Local State'),JSON.stringify({os_crypt:state.os_crypt})); } catch {}
app.setPath('userData',profile);
let stage = 'settings';
app.whenReady().then(async () => {
  const settings = JSON.parse(await fs.readFile(join(normal,'settings.json'),'utf8'));
  const stored = JSON.parse(await fs.readFile(join(normal,'credentials.json'),'utf8'));
  if (settings.byok.provider !== 'openrouter' || !/^https:\/\/openrouter\.ai\/api\/v1\/?$/.test(settings.byok.endpoint)) throw new Error('Configured OpenRouter route required.');
  stage = 'credential'; const key = safeStorage.decryptString(Buffer.from(stored.byok,'base64')); stage = 'provider';
  const started = performance.now(); let headersMs; let firstDataMs; let firstTextMs; let firstThinkingMs; let textChars = 0; let thinkingChars = 0; let usage; let pending = '';
  const response = await fetch(settings.byok.endpoint.replace(/\/$/,'')+'/chat/completions', { method:'POST', headers:{ Authorization:'Bearer '+key,'Content-Type':'application/json' }, body: JSON.stringify({ model: settings.byok.model, messages:[{role:'user',content:'Reply only with OK.'}], max_tokens:128, stream:true, stream_options:{include_usage:true} }), signal:AbortSignal.timeout(60000),redirect:'error' });
  headersMs = performance.now()-started;
  if (response.ok) { const reader = response.body.getReader(); const decoder = new TextDecoder(); while (true) { const {value,done} = await reader.read(); if(done) break; firstDataMs ??= performance.now()-started; pending += decoder.decode(value,{stream:true}); const lines=pending.split('\n');pending=lines.pop(); for(const line of lines) { if(!line.startsWith('data: ')||line.includes('[DONE]'))continue; try { const frame=JSON.parse(line.slice(6));const delta=frame.choices?.[0]?.delta; if(delta?.content) {firstTextMs??=performance.now()-started;textChars+=delta.content.length;} if(delta?.reasoning||delta?.reasoning_content) {firstThinkingMs??=performance.now()-started;thinkingChars+=(delta.reasoning||delta.reasoning_content).length;} if(frame.usage) usage={inputTokens:frame.usage.prompt_tokens,outputTokens:frame.usage.completion_tokens,cost:frame.usage.cost}; }catch{} } } }
  const result = {status:response.status,totalMs:performance.now()-started,headersMs,firstDataMs,firstTextMs,firstThinkingMs,textChars,thinkingChars,usage,maxOutputTokens:128};
  await fs.writeFile(resolve('artifacts/openrouter-probe.json'),JSON.stringify(result,null,2)); console.log(JSON.stringify(result));
}).catch(async () => { const result={error:'The bounded live provider probe could not finish.',stage}; await fs.writeFile(resolve('artifacts/openrouter-probe.json'),JSON.stringify(result)); console.log(JSON.stringify(result)); process.exitCode=1; }).finally(()=>app.quit());
