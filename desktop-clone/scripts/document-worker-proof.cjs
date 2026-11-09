const { app, utilityProcess } = require('electron');
const { resolve, join } = require('node:path');
const { readdir, readFile, writeFile } = require('node:fs/promises');
app.whenReady().then(async () => {
  const folder = process.env.TINYGPT_DOCUMENT_FIXTURES || join('.tools-smoke-profile', (await readdir('.tools-smoke-profile')).filter(name=>name.startsWith('uploads-')).sort().at(-1), 'fixtures');
  const worker = utilityProcess.fork(resolve('out/main/file-worker.js'),[],{stdio:'pipe',serviceName:'Document proof'});
  worker.stdout.on('data',bytes=>process.stdout.write(bytes));worker.stderr.on('data',bytes=>process.stderr.write(bytes));
  let next=0, resolveMessage; const results=[];
  worker.on('message',message=>resolveMessage?.(message));
  const wait=()=>new Promise((resolve,reject)=>{resolveMessage=resolve;setTimeout(()=>reject(Error('Document worker timed out')),60000).unref();});
  try {
    await wait();
    for(const name of ['invoice.png','scanned-invoice.pdf','contract.docx','long-report.txt']){ const waiting=wait();worker.postMessage({id:++next,name,bytes:await readFile(join(folder,name))});const result=await waiting;results.push({name,error:result.error,status:result.document?.status,characters:result.document?.text.length,excerpt:result.document?.text.slice(0,120)});console.log(JSON.stringify(results.at(-1)));}
    await writeFile(resolve('artifacts/document-worker-proof.json'),JSON.stringify(results,null,2));worker.kill();app.exit(results.some(result=>result.error)?1:0);
  }catch(error){console.error(error);worker.kill();app.exit(1);}
}).catch(error=>{console.error(error);app.exit(1);});
