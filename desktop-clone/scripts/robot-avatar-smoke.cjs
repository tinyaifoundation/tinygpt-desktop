const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { resolve } = require('node:path');
const { mkdirSync, mkdtempSync, writeFileSync } = require('node:fs');
const assert = require('node:assert/strict');

(async () => {
  const artifacts = resolve('artifacts/blob-avatar'); mkdirSync(artifacts,{recursive:true});
  mkdirSync('.tools-smoke-profile',{recursive:true});
  const profile = mkdtempSync(resolve('.tools-smoke-profile/blob-avatar-'));
  const env = {...process.env,TINYGPT_TOOLS_PROFILE:profile,TINYGPT_VOICE_PROFILE:profile}; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  const app = await _electron.launch({executablePath:resolve('node_modules/electron/dist/electron.exe'),args:['--force-device-scale-factor=1',resolve('scripts/tools-smoke-main.cjs')],env});
  const errors=[],requests=[];
  try {
    const page=await app.firstWindow();page.setDefaultTimeout(20000);
    page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.url().includes('blob.coleoni.com'))requests.push(request.url());});
    await page.getByRole('button',{name:'Settings',exact:true}).waitFor();
    await page.evaluate(async()=>{
      localStorage.setItem('tinygpt-bot-v4',JSON.stringify({name:'Blobby',color:'#3b93f0',shape:'teardrop',roundness:50,antenna:'ring'}));
      const s=(await window.tinygpt.snapshot()).value;await window.tinygpt.saveSettings({...s.settings,route:'local',local:{...s.settings.local,model:'avatar-fixture',endpoint:'http://127.0.0.1:9/v1'}});
    });
    await page.reload();await page.getByRole('button',{name:'Your bot',exact:true}).waitFor();
    const sidebar=page.locator('.sidebar-bot-avatar');
    assert.equal(await sidebar.getAttribute('data-avatar-engine'),'blob-avatar');assert.equal(await sidebar.getAttribute('data-shape'),'droplet');
    assert.equal(await sidebar.evaluate(n=>n.getBoundingClientRect().width),17);
    await page.getByRole('button',{name:'Expand sidebar',exact:true}).click();
    const labels=await page.locator('.sidebar-nav-action .sidebar-action-label').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().left));assert.ok(labels.every(left=>Math.abs(left-labels[0])<.5));
    await page.getByRole('button',{name:'Your bot',exact:true}).click();
    await page.getByRole('heading',{name:'Introducing Blobby',exact:true}).waitFor();
    const avatar=page.locator('.bot-welcome-avatar');await avatar.locator('svg').waitFor();
    assert.equal(await page.getByText('Antenna',{exact:true}).count(),0);
    assert.equal(await page.locator('agent-robot-avatar').count(),0);
    assert.equal(await page.locator('.bot-editor-presets>button').count(),8);
    assert.equal(await page.locator('.bot-editor-option').count(),21);
    await page.getByRole('tab',{name:'Shape',exact:true}).focus();await page.keyboard.press('ArrowRight');assert.equal(await page.getByRole('tab',{name:'Expression',exact:true}).getAttribute('aria-selected'),'true');await page.keyboard.press('ArrowRight');assert.equal(await page.getByRole('tab',{name:'Color',exact:true}).getAttribute('aria-selected'),'true');await page.keyboard.press('Home');
    await page.getByRole('button',{name:'Lime color',exact:true}).click();
    await page.screenshot({path:resolve(artifacts,'editor-shapes-lime.png'),animations:'disabled'});
    await page.evaluate(()=>{document.documentElement.dataset.motion='reduce';window.dispatchEvent(new Event('tinygpt-motion'));});
    await page.waitForFunction(()=>document.querySelector('.bot-welcome-avatar').dataset.paused==='true');
    const shapes=['Circle','Pebble','Squircle','Capsule','Triangle','Diamond','Hexagon','Star','Cloud','Droplet','Heart','Ghost','Cat','Bear','Bunny','Amoeba','Flower','Clover','Leaf','Gem','Bubble'];
    const outlines=[];
    for (const shape of shapes) {
      await page.getByRole('button',{name:shape+' shape',exact:true}).click();
      assert.equal(await avatar.getAttribute('data-shape'),shape.toLowerCase());
      const paths=await avatar.locator('svg').evaluate(svg=>[...svg.querySelectorAll('path')].map(p=>p.getAttribute('d')).join(' '));assert.ok(!/NaN|Infinity/.test(paths));outlines.push(paths);
    }
    assert.ok(new Set(outlines).size>=20,'Shapes must change the actual SVG outline');
    const animations=['Idle','Thinking','Wink','Wide eyes','Alert','Notification','Surprise','Sleep','Egg','Hexagon','Play','Orbit','Burst','Comet','Nod','Shake','Jump','Spin','Love','Party','Dizzy','Shiver','Melt','Snooze','Rain','Loading','Success','Question'];
    for(const label of animations){await page.getByRole('button',{name:'Preview animation',exact:true}).click();await page.getByRole('menuitemradio',{name:label,exact:true}).click();assert.ok(await avatar.getAttribute('data-animation'));assert.ok(await avatar.locator('svg').count());}
    await page.getByRole('button',{name:'Ghost shape',exact:true}).click();
    await page.getByRole('tab',{name:'Expression',exact:true}).click();assert.equal(await page.locator('.bot-editor-option').count(),26);await page.getByRole('button',{name:'Curious expression',exact:true}).click();
    await page.screenshot({path:resolve(artifacts,'editor-expressions.png'),animations:'disabled'});
    assert.equal(await avatar.getAttribute('data-expression'),'curious');assert.equal(await avatar.getAttribute('data-action'),'idle');
    await page.getByRole('button',{name:'Violet color',exact:true}).click();assert.equal(await avatar.getAttribute('data-color'),'#8b5cf6');
    await page.getByRole('tab',{name:'Color',exact:true}).click();await page.getByRole('button',{name:'Custom bot color',exact:true}).click();
    const picker=page.getByRole('dialog',{name:'Custom bot color',exact:true});const color=picker.getByRole('textbox',{name:'Hex color',exact:true});
    await color.fill('#abc');await color.press('Enter');assert.equal(await avatar.getAttribute('data-color'),'#aabbcc');
    await color.fill('#a35476');await color.press('Enter');await color.press('Escape');
    const selectedColor=await avatar.getAttribute('data-color');
    await page.getByRole('button',{name:'Edit bot name',exact:true}).click();await page.getByRole('textbox',{name:'Bot name',exact:true}).fill('Nova');await page.keyboard.press('Enter');
    await page.screenshot({path:resolve(artifacts,'designer-light.png'),animations:'disabled'});
    await page.evaluate(()=>{document.documentElement.dataset.motion='full';window.dispatchEvent(new Event('tinygpt-motion'));});
    await page.waitForFunction(()=>document.querySelector('.bot-welcome-avatar').dataset.paused==='false');
    const frame=await avatar.locator('svg').innerHTML();
    await page.waitForFunction(before=>document.querySelector('.bot-welcome-avatar svg').innerHTML!==before,frame);
    await page.getByRole('button',{name:'Replay animation',exact:true}).click();await avatar.locator('svg').waitFor();
    await page.reload();await page.getByRole('heading',{name:'Introducing Nova',exact:true}).waitFor();
    const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('tinygpt-bot-v4')));assert.deepEqual(saved,{name:'Nova',color:selectedColor,shape:'ghost',expression:'curious'});
    assert.equal(await sidebar.getAttribute('data-color'),selectedColor);assert.equal(await sidebar.getAttribute('data-shape'),'ghost');
    await page.evaluate(()=>{const key='tinygpt-appearance-v4',v=JSON.parse(localStorage.getItem(key));v.theme='dark';v.reduceMotion='on';const newValue=JSON.stringify(v);localStorage.setItem(key,newValue);window.dispatchEvent(new StorageEvent('storage',{key,newValue}));});
    await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark'&&document.querySelector('.bot-welcome-avatar').dataset.paused==='true');
    const still=await avatar.locator('svg').innerHTML();await page.waitForTimeout(250);assert.equal(await avatar.locator('svg').innerHTML(),still);
    await page.screenshot({path:resolve(artifacts,'designer-dark.png'),animations:'disabled'});
    await page.setViewportSize({width:850,height:600});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.getByRole('tab',{name:'Color',exact:true}).click();await page.getByRole('button',{name:'Custom bot color',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:resolve(artifacts,'designer-narrow.png'),animations:'disabled'});
    assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
    writeFileSync(resolve(artifacts,'proof.json'),JSON.stringify({passed:true,checks:['reference-style visual editor with keyboard-accessible tabs','eight vibrant preset colors','21 shape previews and 26 expression previews','legacy design migration','17px sidebar and aligned labels','21 rendered shapes','28 animation previews','resting expression','custom color and name persistence','live SVG animation','replay','reduced motion freezes rendering','dark and narrow layouts','no hosted avatar requests'],errors},null,2));
    console.log('Blob Avatar desktop proof passed.');
  }catch(error){const page=await app.firstWindow();await page.screenshot({path:resolve(artifacts,'failure.png')}).catch(()=>{});console.error(errors);throw error;}
  finally{await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
