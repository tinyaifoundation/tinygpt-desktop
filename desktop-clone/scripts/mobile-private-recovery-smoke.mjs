import { build } from 'esbuild';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const bundle=await build({stdin:{contents:`export * from './src/renderer/lib/mobile-keys'; export {RemoteClient} from './src/renderer/lib/remote-client';`,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'iife',globalName:'Recovery',platform:'browser'});
const browser=await chromium.launch({channel:'chrome',headless:true});
try{const page=await browser.newPage();await page.route('https://recovery.example/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));await page.goto('https://recovery.example/');await page.addScriptTag({content:bundle.outputFiles[0].text});
 const result=await page.evaluate(async()=>{
  const r=window.Recovery,desktop='a'.repeat(64),grant=crypto.randomUUID(),device=crypto.randomUUID(),text='PRIVATE_RECOVERY_CONTENT_8294';
  await r.savePairingKey(desktop,grant,device,'b'.repeat(64));
  const command={id:crypto.randomUUID(),op:'send',conversationId:crypto.randomUUID(),text};await r.savePrivateRecovery(desktop,[command]);
  const db=await new Promise((resolve,reject)=>{const q=indexedDB.open('tinygpt-remote-keys-v2',2);q.onsuccess=()=>resolve(q.result);q.onerror=reject;});
  const read=store=>new Promise(resolve=>{const q=db.transaction(store).objectStore(store).get(desktop);q.onsuccess=()=>resolve(q.result);});
  const pending=await read('pending'),key=await read('keys');const bytes=new TextDecoder().decode(pending.ciphertext);
  if(bytes.includes(text)||JSON.stringify(pending).includes(text)||key.key.extractable)throw Error('Recovery content or key is exposed');
  const restored=await r.loadPrivateRecovery(desktop);if(restored[0].text!==text)throw Error('Recovery mismatch');
  await r.savePrivateRecovery(desktop,[]);sessionStorage.setItem('tinygpt-pending:'+desktop,JSON.stringify([command]));
  const client=new r.RemoteClient(desktop,()=>{},()=>{},()=>{});await client.restore();if(sessionStorage.getItem('tinygpt-pending:'+desktop))throw Error('Plaintext recovery was not removed');
  if((await r.loadPrivateRecovery(desktop))[0].text!==text)throw Error('Legacy recovery migration failed');client.close();
  await r.savePairingKey(desktop,crypto.randomUUID(),device,'c'.repeat(64));let refused=false;try{await r.loadPrivateRecovery(desktop);}catch{refused=true;}if(!refused)throw Error('Old recovery survived a different pairing key');db.close();
  return {checks:['non-exportable local key','AES-GCM ciphertext storage','exact command recovery','plaintext session-storage migration removed','different pairing key rejected'],errors:[]};
 });assert.equal(result.checks.length,5);console.log(JSON.stringify(result));
}finally{await browser.close();}
