import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { oauthPageHtml } from '../src/shared/oauth-page.ts';
import { connectorSplashNames } from '../src/shared/connector-splashes.ts';
const require = createRequire(import.meta.url);
const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const phase1 = process.argv.includes('--phase1');
const names = phase1 ? { higgsfield: 'Higgsfield', linear: 'Linear' } : connectorSplashNames;
const output = phase1 ? 'artifacts/connector-phase1' : 'artifacts/connector-splashes-v1';
const assets = id => ({ regular: '/font/400', medium: '/font/500', semibold: '/font/600', hero: `/art/${id}` });
function preview(id) {
  return oauthPageHtml(assets(id), 'preview', '').replace('Finishing your connection', 'You’re connected').replace('Checking your account…', 'You can close this tab.').replace('<body>', '<body data-status="connected">').replace('class="brand">TinyGPT', `class="brand">TinyGPT + ${names[id]}`);
}
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  const art = /^\/art\/([a-z]+)$/.exec(path);
  const font = /^\/font\/(400|500|600)$/.exec(path);
  if (art && art[1] in names) { response.writeHead(200, { 'Content-Type': 'image/webp' }).end(await readFile(`src/renderer/assets/connectors/splashes/${art[1]}-v1.webp`)); return; }
  if (font) { response.writeHead(200, { 'Content-Type': 'font/woff2' }).end(await readFile(require.resolve('@fontsource-variable/figtree/files/figtree-latin-wght-normal.woff2'))); return; }
  const single = /^\/review\/([a-z]+)$/.exec(path);
  if (single && single[1] in names) { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(preview(single[1])); return; }
  const example = preview(Object.keys(names)[0]);
  const style = example.match(/<style[^>]*>([\s\S]*?)<\/style>/)[1];
  const cards = Object.keys(names).map(id => preview(id).match(/<main>[\s\S]*?<\/main>/)[0]).join('');
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><html><head><meta charset="utf-8"><title>TinyGPT · Plugin splash review</title><style>${style}body{display:block;padding:40px 48px}header{margin:0 0 28px}header h1{font-size:25px;margin-bottom:6px}header p{font-size:13px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:26px}main{width:100%;max-width:none}.content{padding:22px 22px 26px}main h1{font-size:25px;min-height:33px}.status-icon{display:none}.brand{margin-bottom:16px}button{margin-top:20px}.footnote{margin-top:20px}main .hero{height:172px}main .hero img{object-position:center center}</style></head><body><header><h1>Plugin connections, made for TinyGPT</h1><p>${Object.keys(names).length} image-generated splash illustrations · Version 1 · Design review</p></header><section class="grid">${cards}</section></body></html>`);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
await mkdir(output, { recursive: true });
await mkdir('.tmp', { recursive: true });
const main = resolve('.tmp/connector-art-review-main.cjs');
await writeFile(main, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(resolve('.test-profile/connector-art-review'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:1680,height:1200,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.setPosition(-10000,-10000);w.setIgnoreMouseEvents(true);w.webContents.setBackgroundThrottling(false);w.loadURL(${JSON.stringify(origin)}).then(()=>w.showInactive());});`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [main], env });
try {
  const page = await app.firstWindow(); const errors=[]; page.on('pageerror', e=>errors.push(e.message));
  await page.setViewportSize(phase1 ? { width: 1280, height: 720 } : { width: 1680, height: 1160 });
  const ready = async () => { await page.evaluate(()=>document.fonts.ready); await page.waitForFunction(()=>[...document.images].every(image=>image.complete && image.naturalWidth>0)); };
  await ready();
  if (phase1) await page.addStyleTag({ content: '.grid{grid-template-columns:repeat(2,minmax(0,1fr))}' });
  for (const theme of ['dark','light']) { await page.emulateMedia({ colorScheme: theme }); await page.screenshot({ path: `${output}/review-${theme}.png`, fullPage:true }); }
  for (const id of Object.keys(names)) { await page.goto(`${origin}/review/${id}`); await page.setViewportSize({ width: 980, height: 820 }); await page.emulateMedia({ colorScheme:'dark' }); await ready(); await page.screenshot({ path:`${output}/${id}-dark.png` }); }
  if(errors.length)throw Error(errors.join('\n'));
  console.log(JSON.stringify({screenshots:output,plugins:Object.values(names),checks:['all generated artworks decode','real callback template','bundled fonts load','light and dark review sheets','individual callback screenshots'],errors}));
} finally { await app.close(); server.close(); }
