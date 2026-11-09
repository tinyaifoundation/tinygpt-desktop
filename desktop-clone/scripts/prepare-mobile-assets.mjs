import { chromium } from 'playwright';
import { mkdir, readFile, writeFile, copyFile, access } from 'node:fs/promises';
const root='src/renderer/public'; await mkdir(root+'/splash',{recursive:true}); await mkdir(root+'/fonts',{recursive:true});
for(const icon of ['ios-default','dark','tinted-light','clear-light','clear-dark'])await copyFile('src/main/assets/dock-icons/tinygpt-'+icon+'.png',root+'/icons/app-'+icon+'.png');
const font=await readFile('node_modules/@fontsource-variable/figtree/files/figtree-latin-wght-normal.woff2');await writeFile(root+'/fonts/figtree-latin.woff2',font);
const sizes=[[375,667,2],[414,736,3],[375,812,3],[390,844,3],[393,852,3],[402,874,3],[414,896,3],[428,926,3],[430,932,3],[440,956,3],[768,1024,2],[820,1180,2],[834,1194,2],[1024,1366,2]];
const browser=await chromium.launch({headless:true,channel:'chrome'});const links=[];
try{for(const [width,height,scale]of sizes){const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:scale});const page=await context.newPage();
 for(const landscape of [false,true])for(const dark of [false,true]){
  const name=`text-v2-${width}-${height}-${scale}-${landscape?'landscape':'portrait'}-${dark?'dark':'light'}.png`,file=root+'/splash/'+name;
  try{await access(file);}catch{
   await page.setViewportSize({width:landscape?height:width,height:landscape?width:height});
   await page.setContent(`<style>@font-face{font-family:Figtree;src:url(data:font/woff2;base64,${font.toString('base64')})}*{box-sizing:border-box}body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:${dark?'#151517':'#fff'};color:${dark?'#f5f5f6':'#171719'};font:500 24px Figtree,system-ui}main{display:flex;flex-direction:column;align-items:center;gap:22px}i{width:22px;height:22px;border:2px solid ${dark?'#f5f5f633':'#17171926'};border-top-color:currentColor;border-radius:50%;transform:rotate(-35deg)}</style><main><span>TinyGPT</span><i></i></main>`);await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:file});
  }
  links.push(`<link rel="apple-touch-startup-image" href="/splash/${name}" media="(device-width: ${width}px) and (device-height: ${height}px) and (-webkit-device-pixel-ratio: ${scale}) and (orientation: ${landscape?'landscape':'portrait'}) and (prefers-color-scheme: ${dark?'dark':'light'})">`);
 }
 await context.close();
}}finally{await browser.close();}
const path='src/renderer/mobile.html';let html=await readFile(path,'utf8');html=html.replace(/<!-- mobile-startup-images -->[\s\S]*?<!-- \/mobile-startup-images -->/,'<!-- mobile-startup-images -->\n'+links.join('\n')+'\n<!-- /mobile-startup-images -->');html=html.replace('<style>#mobile-boot','<style>@font-face{font-family:Figtree;src:url(/fonts/figtree-latin.woff2) format("woff2");font-display:swap}#mobile-boot').replace('font:500 20px system-ui,sans-serif','font:500 20px Figtree,system-ui,sans-serif');await writeFile(path,html);
console.log(`Prepared ${links.length} iPhone/iPad startup images and five existing icon colors.`);
