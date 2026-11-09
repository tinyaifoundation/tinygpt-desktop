const { app, utilityProcess } = require('electron');
const { resolve, join } = require('node:path');
const { writeFileSync, readFileSync } = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const profile = process.env.TINYGPT_RAG_PROOF_PROFILE;
const report = { packaged: false, search: [], pdf: '', documents: [], errors: [] };
const workers = [];
function fork(name) {
  const worker = utilityProcess.fork(join(app.getAppPath(), 'out/main', `${name}.js`), [], { stdio: 'ignore' }); workers.push(worker);
  let counter = 0; const pending = new Map();
  const ready = new Promise((done, reject) => {
    worker.on('message', event => {
      if (event.ready) { done(); return; }
      const item = pending.get(event.id); if (!item) return; pending.delete(event.id);
      event.ok === false || event.error ? item.reject(new Error(event.diagnostic || event.error)) : item.done(event.value ?? event.document ?? event.text);
    });
    worker.once('exit', () => { const error = new Error(`${name} stopped`); reject(error); for (const item of pending.values()) item.reject(error); pending.clear(); });
  });
  return async input => { await ready; const id = ++counter; return new Promise((done, reject) => { pending.set(id, { done, reject }); worker.postMessage({ id, ...input }); }); };
}
function pdf() {
  const stream = 'BT /F1 12 Tf 72 720 Td (PACKAGED_PDF_MARKER) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let text = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(text); text += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(text);
}
app.whenReady().then(async () => {
  try {
    report.packaged = app.isPackaged;
    if (!app.isPackaged) throw new Error('The proof must run from its packaged executable.');
    const libraryPath = join(profile, 'library.sqlite'); const db = new DatabaseSync(libraryPath);
    const projectId = db.prepare("SELECT project_id FROM knowledge_documents WHERE title='hours.md'").get().project_id; db.close();
    const request = fork('embedding-worker');
    const config = { cacheDir: profile, libraryPath, modelRoot: join(process.resourcesPath, 'rag') };
    await request({ ...config, type: 'load' });
    for (let i = 0; i < 20; i++) if (!await request({ ...config, type: 'index' })) break;
    report.search = await request({ ...config, type: 'search', scope: { projectId }, query: 'What time does the workplace shut?', limit: 3, semantic: true });
    if (report.search[0]?.title !== 'hours.md') throw new Error('Packaged retrieval did not return the expected document.');
    const extract = fork('file-worker'); report.pdf = (await extract({ name: 'document.pdf', bytes: pdf() })).text;
    if (!report.pdf.includes('PACKAGED_PDF_MARKER')) throw new Error('The packaged document worker did not extract PDF text.');
    for (const name of ['invoice.png','scanned-invoice.pdf','contract.docx','long-report.txt']) {
      const document = await extract({name,bytes:readFileSync(join(process.resourcesPath,'document-fixtures',name))});
      if (document.status !== 'ready' || !document.text || /\.(?:pdf|png)$/.test(name) && !document.text.includes('4287')) throw Error('Packaged document extraction failed: '+name);
      report.documents.push({name,status:document.status,characters:document.text.length});
    }
  } catch (error) { report.errors.push(error.message); process.exitCode = 1; }
  finally { writeFileSync(join(profile, 'proof.json'), JSON.stringify(report, null, 2)); workers.forEach(worker => worker.kill()); app.exit(report.errors.length ? 1 : 0); }
});
setTimeout(() => { report.errors.push('Packaged worker proof timed out.'); writeFileSync(join(profile, 'proof.json'), JSON.stringify(report)); workers.forEach(worker => worker.kill()); app.exit(1); }, 90000);
