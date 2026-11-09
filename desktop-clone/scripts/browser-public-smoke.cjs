// Optional public-page check, no model calls, credentials, or user browser profile.
const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { build } = require('esbuild');
const { resolve } = require('node:path');
const { mkdir, writeFile } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');

async function main() {
  await mkdir(resolve('artifacts'), { recursive: true });
  const fixtureMain = resolve('artifacts/browser-public-main.cjs');
  await writeFile(resolve('artifacts/browser-accessibility-preload.cjs'), "const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('browserFixture',{operate:data=>ipcRenderer.invoke('fixture:operation',data)});");
  await build({ entryPoints: [resolve('scripts/browser-accessibility-smoke-main.ts')], outfile: fixtureMain, bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'] });
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', `public-${Date.now()}`) }; delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [fixtureMain], env });
    const page = await app.firstWindow(); await page.waitForFunction(() => !!window.browserFixture);
    const conversationId = randomUUID(); let tabId;
    async function operation(method, args = {}) {
      const result = await page.evaluate(data => window.browserFixture.operate(data), { method, conversationId, tabId, ...args });
      if (!result.ok) throw new Error(result.error); return result.value;
    }
    const initial = await operation('page', { url: 'https://openrouter.ai/rankings' }); tabId = initial.tabId;
    console.log(JSON.stringify({ phase: 'initial', targets: initial.elements.length, target58: initial.elements.find(target => target.id === 't58') }));
    const filter = initial.elements.find(target => target.id === 't58') ?? initial.elements.find(target => target.role === 'combobox');
    if (filter) {
      const approved = await operation('describe', { elementId: filter.id });
      try {
        const after = await operation('click', { elementId: filter.id, expected: approved });
        console.log(JSON.stringify({ phase: 'filter-click', ok: true, url: after.url, targets: after.elements.length }));
      } catch (error) {
        console.log(JSON.stringify({ phase: 'filter-click', error: error.message }));
        const after = await operation('read');
        console.log(JSON.stringify({ phase: 'filter-recovery', before: approved, filters: after.elements.filter(target => target.role === 'combobox').slice(0, 4) }));
      }
    }
    const targets = initial.elements.filter(target => ['link', 'button', 'combobox'].includes(target.role)).slice(0, 65);
    for (const delay of [300, 700, 1500]) {
      await new Promise(done => setTimeout(done, delay));
      const checks = await Promise.all(targets.map(async target => {
        try { await operation('describe', { elementId: target.id }); return null; }
        catch (error) { return { id: target.id, label: target.label, error: error.message }; }
      }));
      console.log(JSON.stringify({ phase: 'revalidation', delay, staleCount: checks.filter(Boolean).length, examples: checks.filter(Boolean).slice(0, 3) }));
    }
    const current = await operation('read');
    console.log(JSON.stringify({ phase: 'fresh', targets: current.elements.length, retained: current.elements.filter(target => initial.elements.some(old => old.id === target.id)).length }));
    for (const target of current.elements.slice(0, 10)) await operation('describe', { elementId: target.id });
    console.log(JSON.stringify({ phase: 'current-reference-validation', ok: true }));
  } finally { if (app) await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
