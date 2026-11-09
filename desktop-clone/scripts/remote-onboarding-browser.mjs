import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {chromium} from 'playwright';
const require=createRequire(import.meta.url);
const safari='Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1';

export async function checkMobileOnboarding({base,remote,conversationId,directory}) {
  const browser=await chromium.launch({channel:'chrome',headless:true}); const errors=[],failures=[];
  const screenshots=join(directory,'onboarding');await mkdir(screenshots,{recursive:true});
  function watch(page){page.on('pageerror',error=>errors.push(error.message));page.on('response',response=>{if(response.status()>=400)failures.push({path:new URL(response.url()).pathname,status:response.status()});});}
  try {
    const invitation=await remote.pair(conversationId,base),fields=new URLSearchParams(new URL(invitation.url).hash.slice(1));
    const brave=await browser.newContext({viewport:{width:390,height:844},userAgent:safari+' Brave/1',permissions:['clipboard-read','clipboard-write']});
    const bravePage=await brave.newPage();watch(bravePage);await bravePage.goto(invitation.url);
    await bravePage.getByRole('button',{name:'Copy link for Safari',exact:true}).waitFor();
    await remote.refreshDevices();assert.equal(remote.status().requests.length,0,'Opening the installation page must not consume the QR');
    await bravePage.getByRole('button',{name:'Continue in browser',exact:true}).waitFor();
    await bravePage.getByRole('button',{name:'Copy link for Safari',exact:true}).click();
    const installURL=await bravePage.evaluate(()=>navigator.clipboard.readText());
    assert.equal(new URL(installURL).searchParams.get('setup'),fields.get('desktop'));assert.equal(new URL(installURL).hash,'');assert.ok(!installURL.includes(fields.get('key')));
    await bravePage.screenshot({path:join(screenshots,'brave-install.png')});
    const safariContext=await browser.newContext({viewport:{width:390,height:844},userAgent:safari});
    const safariPage=await safariContext.newPage();watch(safariPage);await safariPage.goto(installURL);
    await safariPage.getByRole('list',{name:'Install TinyGPT',exact:true}).waitFor();
    await waitFor(async()=> (await safariContext.cookies()).some(cookie=>cookie.name==='tg_setup'));
    await safariPage.screenshot({path:join(screenshots,'safari-install.png')});
    await remote.refreshDevices();assert.equal(remote.status().requests.length,0,'Safari install instructions must not create a pairing');
    // Model iOS copying only cookies into a standalone app. No IndexedDB or
    // session/local storage is carried over; the camera decodes the real SVG.
    await build({entryPoints:['src/renderer/components/PairingQRCode.tsx'],outfile:join(directory,'onboarding-qr.cjs'),bundle:true,platform:'node',format:'cjs',packages:'external',jsx:'automatic'});
    const {PairingQRCode}=require(join(directory,'onboarding-qr.cjs')),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
    const markup=renderToStaticMarkup(React.createElement(PairingQRCode,{value:invitation.url}));
    const svg=markup.slice(markup.indexOf('<svg'),markup.indexOf('</svg>')+6).replace('<svg ','<svg width="768" height="768" ');
    const image='data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64');
    const installed=await browser.newContext({viewport:{width:390,height:844},userAgent:safari,permissions:['camera'],storageState:{cookies:await safariContext.cookies(),origins:[]}});
    await installed.addInitScript(({image})=>{
      Object.defineProperty(navigator,'standalone',{get:()=>true});
      window.__cameraStreams=[];window.__cameraReady=false;
      navigator.mediaDevices.getUserMedia=async()=>{
        const bitmap=new Image();bitmap.src=image;await bitmap.decode();const canvas=document.createElement('canvas');canvas.width=1920;canvas.height=1080;
        const context=canvas.getContext('2d'),draw=()=>{context.fillStyle='#c9d3df';context.fillRect(0,0,canvas.width,canvas.height);if(window.__cameraReady){context.imageSmoothingEnabled=false;context.drawImage(bitmap,760,340,400,400);}};
        draw();const timer=setInterval(draw,100),stream=canvas.captureStream(10);window.__cameraStreams.push(stream);window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});return stream;
      };
    },{image});
    const installedPage=await installed.newPage();watch(installedPage);await installedPage.goto(base+'/app/');
    await installedPage.getByRole('dialog',{name:'Connect a computer',exact:true}).waitFor();
    assert.equal(await installedPage.evaluate(()=>window.__cameraStreams.length>0),true,'First launch must open the scanner automatically');
    await installedPage.screenshot({path:join(screenshots,'installed-scanner.png')});
    await installedPage.evaluate(()=>{window.__cameraReady=true;});
    const pending=await waitFor(async()=>{await remote.refreshDevices();return remote.status().requests.find(item=>item.grantId===fields.get('invitation'));});
    await installedPage.getByRole('heading',{name:'One tap on your computer.',exact:true}).waitFor();
    assert.equal(await installedPage.evaluate(()=>window.__cameraStreams.every(stream=>stream.getTracks().every(track=>track.readyState==='ended'))),true,'Scanner must release every camera stream');
    await remote.approvePairing(pending.id,true);await installedPage.locator('.mobile-thread').waitFor({timeout:20000});
    await installedPage.screenshot({path:join(screenshots,'installed-connected.png')});
    await installedPage.reload();await installedPage.locator('.mobile-thread').waitFor({timeout:20000});assert.equal(await installedPage.getByRole('dialog',{name:'Connect a computer',exact:true}).count(),0,'Returning users must open chat without scanning');
    // Browser mode remains an explicit alternative, using its own fresh grant.
    const browserInvitation=await remote.pair(conversationId,base);await bravePage.goto(browserInvitation.url);
    await bravePage.getByRole('button',{name:'Continue in browser',exact:true}).click();
    const browserGrant=new URLSearchParams(new URL(browserInvitation.url).hash.slice(1)).get('invitation');
    const browserPending=await waitFor(async()=>{await remote.refreshDevices();return remote.status().requests.find(item=>item.grantId===browserGrant);});
    await remote.approvePairing(browserPending.id,true);await bravePage.locator('.mobile-thread').waitFor({timeout:20000});
    await bravePage.screenshot({path:join(screenshots,'browser-connected.png')});
    assert.deepEqual(errors,[]);await remote.revoke(pending.id);await remote.revoke(browserPending.id);
    console.log(JSON.stringify({checks:['Brave landing does not pair','Safari link carries no keys','cookie-only installed context','automatic scanner on first launch','actual desktop QR through landscape camera frames','camera cleanup','one approval opens encrypted chat','reload skips setup','explicit Continue in browser'],errors,screenshots}));
  } catch(error){console.error('Onboarding diagnostics:',JSON.stringify({errors,failures}));let index=0;for(const context of browser.contexts())for(const page of context.pages()){console.error((await page.locator('body').innerText()).slice(0,900));await page.screenshot({path:join(screenshots,'failure-'+index+++'.png')});}throw error;} finally {await browser.close();}
}
async function waitFor(check){const until=Date.now()+30000;while(Date.now()<until){const value=await check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,500));}throw Error('Onboarding check timed out.');}
