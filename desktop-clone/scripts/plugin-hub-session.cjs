// Development control of TinyGPT's own desktop window through its normal
// renderer bridge. No vault reads, exported tokens, or model requests.
const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createInterface } = require('node:readline');
const { resolve } = require('node:path');
async function main() {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const desktop = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('.')], env });
  const page = await desktop.firstWindow(); page.setDefaultTimeout(20000);
  await page.getByRole('button', { name: 'Plugins library', exact: true }).waitFor();
  const metadata = () => page.evaluate(async () => {
    const library = await window.tinygpt.library(), hub = await window.tinygpt.skills(), plugins = await window.tinygpt.plugins();
    if (!library.ok || !hub.ok || !plugins.ok) throw Error('The app bridge is unavailable.');
    return { activeRuns: library.value.activeRuns.length, catalogSkills: hub.value.catalog.length, installedSkills: hub.value.entries.reduce((sum, entry) => sum + entry.manifest.skills.length, 0), drafts: hub.value.drafts.length, plugins: plugins.value.entries.map(entry => ({ id: entry.id, name: entry.manifest.name, status: entry.status, message: entry.message, oauthConfigured: entry.oauthConfigured, tools: entry.tools.map(tool => tool.originalName) })) };
  });
  const showSkills = async () => { await page.getByRole('button', { name: 'Plugins library', exact: true }).click(); await page.getByRole('tab', { name: 'Skills', exact: true }).click(); await page.getByRole('heading', { name: 'Skills', exact: true }).waitFor(); };
  if (process.env.TINYGPT_KEEP_CHAT !== '1') await showSkills(); console.log(JSON.stringify(await metadata()));
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    try {
      const input = JSON.parse(line); let result;
      if (input.action === 'snapshot') result = await metadata();
      else if (input.action === 'stage-connectors') { result = await page.evaluate(async () => { for (const kind of ['gcalendar', 'notion', 'slack']) { const result = await window.tinygpt.installConnector(kind); if (!result.ok) throw Error(result.error); } return true; }); result = await metadata(); }
      else if (input.action === 'check-existing') { result = await page.evaluate(async () => { const entries = (await window.tinygpt.plugins()).value.entries; for (const entry of entries.filter(entry => ['gmail', 'gdrive', 'github'].includes(entry.manifest.connector))) { const result = await window.tinygpt.connectPlugin(entry.id); if (!result.ok) throw Error(result.error); } return true; }); result = await metadata(); }
      else if (input.action === 'show-voice') { await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Voice', exact: true }).click(); await page.getByRole('switch', { name: 'Enable bundled transcription', exact: true }).waitFor(); result = await metadata(); }
      else if (input.action === 'show-skills') { await showSkills(); result = await metadata(); }
      else if (input.action === 'close') { if ((await metadata()).activeRuns) throw Error('An active reply must finish before closing.'); await desktop.close(); process.exit(0); }
      else throw Error('Unknown action.');
      console.log(JSON.stringify(result));
    } catch (error) { console.log(JSON.stringify({ error: error.message })); }
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
