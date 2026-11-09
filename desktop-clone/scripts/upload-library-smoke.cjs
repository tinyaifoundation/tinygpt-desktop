const { _electron } = require('playwright');
const { createServer } = require('node:http');
const { mkdir, writeFile, readFile } = require('node:fs/promises');
const { resolve, join } = require('node:path');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const delay = ms => new Promise(done => setTimeout(done, ms));
const value = result => { assert.equal(result.ok, true, result.error); return result.value; };
(async () => {
  const profile = resolve('.tools-smoke-profile', `uploads-${Date.now()}`), files = join(profile, 'fixtures'); await mkdir(files, { recursive: true });
  require('esbuild').buildSync({ entryPoints: ['tests/fixtures/document-fixtures.ts'], bundle: true, platform: 'node', packages: 'external', outfile: '.tmp/document-fixtures.cjs' });
  const { invoiceImage, scannedPdf } = require('../.tmp/document-fixtures.cjs');
  await writeFile(join(files, 'invoice.png'), invoiceImage().toBuffer('image/png')); await writeFile(join(files, 'scanned-invoice.pdf'), scannedPdf());
  const zip = new JSZip(); zip.file('word/document.xml', '<w:document><w:p><w:t>Office document ORCHID contract renewal.</w:t></w:p></w:document>'); await writeFile(join(files, 'contract.docx'), await zip.generateAsync({ type: 'nodebuffer' }));
  await writeFile(join(files, 'long-report.txt'), 'HEAD_BODY_MUST_NOT_BE_JAMMED '.repeat(10000) + '\nTAIL_STELLAR_92731 invoice reconciliation.');
  const requests = [], errors = [], server = createServer(async (request, response) => {
    let body = ''; for await (const bytes of request) body += bytes; if (request.url !== '/v1/chat/completions') return response.writeHead(404).end();
    requests.push(JSON.parse(body)); response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end('data: '+JSON.stringify({ choices: [{ delta: { role:'assistant',content: 'Evidence received.' },finish_reason:null }] })+'\n\ndata: '+JSON.stringify({ choices:[{delta:{},finish_reason:'stop'}] })+'\n\ndata: [DONE]\n\n');
  }); await new Promise(done => server.listen(0, '127.0.0.1', done));
  let desktop, page;
  try {
    const env = { ...process.env, TINYGPT_TOOLS_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE;
    desktop = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/tools-smoke-main.cjs')], env });
    page = await desktop.firstWindow(); page.setDefaultTimeout(30000); page.on('pageerror', error => errors.push(error.message));
    await desktop.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.setIgnoreMouseEvents(true); window.setPosition(-10000,-10000); window.webContents.setBackgroundThrottling(false); window.showInactive(); } });
    await page.getByRole('button', { name: 'Settings', exact:true }).waitFor();
    const conversation = value(await page.evaluate(async endpoint => { const snapshot = (await window.tinygpt.snapshot()).value; const saved = await window.tinygpt.saveSettings({ ...snapshot.settings, mode:'chat',route:'local',local:{...snapshot.settings.local,endpoint,model:'upload-fixture',tools:false,contextWindowTokens:65536}, toolPermissions:{...snapshot.settings.toolPermissions,read:'allow'} }); if(!saved.ok)return saved; return window.tinygpt.createConversation(null); }, `http://127.0.0.1:${server.address().port}/v1`));
    await desktop.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled:false,filePaths:files }); }, ['invoice.png','scanned-invoice.pdf','contract.docx','long-report.txt'].map(name => join(files,name)));
    const attached = value(await page.evaluate(id => window.tinygpt.chooseAttachments(id), conversation.id)).conversation.sources;
    assert.equal(attached.length,4); assert.ok(attached.some(source => source.processing?.status === 'preparing'));
    // Send immediately, including while OCR is pending. The app handles readiness.
    value(await page.evaluate(({id,sources}) => window.tinygpt.sendMessage(id,'Find TAIL_STELLAR_92731 and invoice total 4287; use the attached evidence.',sources), { id:conversation.id,sources:attached.map(source=>source.id) }));
    let completed;
    for(let i=0;i<360;i++){ completed=value(await page.evaluate(id=>window.tinygpt.conversation(id),conversation.id)); if(completed.messages.at(-1)?.status!=='streaming'&&completed.messages.length>=2)break; await delay(250); }
    assert.equal(completed.messages.at(-1).status,'complete',JSON.stringify(completed));
    assert.ok(completed.tools.some(tool=>tool.name==='file_prepare'&&tool.status==='success'));
    const details = await page.evaluate(async ids => Promise.all(ids.map(id=>window.tinygpt.librarySource(id))),attached.map(source=>source.id));
    for(const result of details){const source=value(result);assert.equal(source.processing.status,'ready',JSON.stringify(source.processing)); if(source.title.endsWith('.pdf')||source.title.endsWith('.png'))assert.match(source.text,/4287/);}
    const resourceSnapshot = await desktop.evaluate(({app}) => app.getAppMetrics().map(({type,name,serviceName,memory}) => ({type,name,serviceName,memory})));
    const body = requests.filter(request=>JSON.stringify(request).includes('Find TAIL_STELLAR_92731')).at(-1); assert.ok(body); const serialized = JSON.stringify(body); assert.ok(serialized.length<22000,`Unexpected prompt size: ${serialized.length}`); assert.ok((serialized.match(/HEAD_BODY_MUST_NOT_BE_JAMMED/g)||[]).length<40,'Document body was injected into context');
    const target=attached.find(source=>source.title==='long-report.txt'); assert.ok(value(await page.evaluate(()=>window.tinygpt.searchLibrary('TAIL_STELLAR_92731'))).includes(target.id));
    value(await page.evaluate(id=>window.tinygpt.excludeSource(id,true),target.id)); assert.equal(value(await page.evaluate(id=>window.tinygpt.librarySource(id),target.id)).excluded,true);
    value(await page.evaluate(id=>window.tinygpt.excludeSource(id,false),target.id));
    const destination=value(await page.evaluate(()=>window.tinygpt.createConversation(null))); value(await page.evaluate(({id,dest})=>window.tinygpt.reuseSource(id,dest),{id:target.id,dest:destination.id}));
    assert.equal(value(await page.evaluate(id=>window.tinygpt.conversation(id),destination.id)).sources.length,1);
    const downloaded=join(profile,'original-download.txt'); await desktop.evaluate(({dialog},path)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:path});},downloaded);
    value(await page.evaluate(id=>window.tinygpt.downloadSource(id),target.id)); assert.deepEqual(await readFile(downloaded),await readFile(join(files,'long-report.txt')));
    await page.reload(); await page.getByRole('button',{name:'Library',exact:true}).click(); await page.getByRole('tab',{name:'Uploads',exact:true}).click();
    await page.getByRole('textbox',{name:'Search Library',exact:true}).fill('ORCHID'); await page.getByRole('button',{name:'Open contract.docx',exact:true}).waitFor(); assert.equal(await page.getByRole('button',{name:'Open scanned-invoice.pdf',exact:true}).count(),0); await page.getByRole('textbox',{name:'Search Library',exact:true}).fill('');
    await page.getByRole('button',{name:'Open scanned-invoice.pdf',exact:true}).waitFor();
    await page.getByRole('button',{name:'Open scanned-invoice.pdf',exact:true}).click(); await page.getByRole('dialog',{name:'scanned-invoice.pdf',exact:true}).waitFor(); await page.screenshot({path:resolve('artifacts/upload-library-preview.png')});
    await page.getByRole('button',{name:'Exclude from retrieval',exact:true}).click(); await page.getByRole('button',{name:'Include in retrieval',exact:true}).waitFor(); await page.getByRole('button',{name:'Include in retrieval',exact:true}).click(); await page.getByRole('button',{name:'Exclude from retrieval',exact:true}).waitFor();
    let documentReaderUnloaded = false;
    for (let i = 0; i < 40; i++) { documentReaderUnloaded = await desktop.evaluate(({app}) => !app.getAppMetrics().some(metric => metric.name === 'TinyGPT document reader')); if (documentReaderUnloaded) break; await delay(1000); }
    assert.equal(documentReaderUnloaded, true, 'The idle document reader retained its process.');
    assert.deepEqual(errors,[]);
    const report={result:'passed',checks:['real Electron document worker','image and scanned PDF local OCR','DOCX ingestion','Send while preparing','compact manifests and bounded evidence at 64k','Library content search','retrieval exclusion/re-enable','reuse into another chat','original bytes download','Library UI preview','document worker releases memory after idle'],promptCharacters:serialized.length,resourceSnapshot,documentReaderUnloaded,sources:details.map(result=>({title:result.value.title,characters:result.value.text.length,status:result.value.processing.status})),errors};
    await writeFile(resolve('artifacts/upload-library-smoke.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify(report));
  } catch(error){if(page){await page.screenshot({path:resolve('artifacts/upload-library-failure.png')}).catch(()=>{});console.log((await page.locator('body').innerText()).slice(-1800));}throw error;}
  finally{await desktop?.close();server.closeAllConnections();await new Promise(done=>server.close(done));}
})().catch(error=>{console.error(error);process.exitCode=1;});
